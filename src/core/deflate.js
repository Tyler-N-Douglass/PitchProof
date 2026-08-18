/**
 * Raw DEFLATE compression (RFC 1951), pure, synchronous and deterministic.
 *
 * The emitter compresses the proof model with this and the artifact inflates it
 * with the platform `DecompressionStream('deflate-raw')`. It is deliberately not
 * `CompressionStream`: browser deflate implementations are free to differ, and
 * the determinism law (§5) requires two emits of the same project to be
 * byte-identical on any machine. This implementation is fixed, so they are.
 *
 * Coding: LZ77 with a 32 KiB window and hash chains, then per-block choice of
 * dynamic Huffman / fixed Huffman / stored, whichever is smallest. Code lengths
 * are length-limited to 15 bits by package-merge, which is optimal rather than
 * heuristic.
 *
 * @module core/deflate
 */

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_CHAIN = 128;
const BLOCK_SYMBOLS = 1 << 16;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** @param {number} len @returns {number} index into LENGTH_BASE */
function lengthIndex(len) {
  let i = LENGTH_BASE.length - 1;
  while (i > 0 && LENGTH_BASE[i] > len) i--;
  return i;
}
/** @param {number} dist @returns {number} index into DIST_BASE */
function distIndex(dist) {
  let i = DIST_BASE.length - 1;
  while (i > 0 && DIST_BASE[i] > dist) i--;
  return i;
}

class BitWriter {
  constructor() { this.buf = new Uint8Array(1024); this.len = 0; this.bit = 0; this.acc = 0; }
  /** @param {number} n */
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  /** Write `count` bits of `value`, least-significant bit first. */
  write(value, count) {
    this.acc |= (value >>> 0) << this.bit;
    this.bit += count;
    while (this.bit >= 8) {
      this.ensure(1);
      this.buf[this.len++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.bit -= 8;
    }
  }
  /** Write a Huffman code, most-significant bit first as DEFLATE requires. */
  writeCode(code, length) {
    let rev = 0;
    for (let i = 0; i < length; i++) rev |= ((code >>> (length - 1 - i)) & 1) << i;
    this.write(rev, length);
  }
  alignByte() { if (this.bit > 0) { this.ensure(1); this.buf[this.len++] = this.acc & 0xff; this.acc = 0; this.bit = 0; } }
  /** @param {Uint8Array} bytes */
  writeBytes(bytes) { this.ensure(bytes.length); this.buf.set(bytes, this.len); this.len += bytes.length; }
  finish() { this.alignByte(); return this.buf.subarray(0, this.len); }
}

/**
 * Length-limited Huffman code lengths by package-merge. Optimal for the given
 * limit, and — unlike the frequency-fudging heuristics — deterministic in a way
 * that is easy to reason about.
 * @param {Int32Array|number[]} freqs
 * @param {number} limit
 * @returns {Uint8Array} code length per symbol, 0 for unused
 */
export function packageMerge(freqs, limit) {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  /** @type {{w: number, syms: number[]}[]} */
  const coins = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) coins.push({ w: freqs[i], syms: [i] });
  if (coins.length === 0) return lengths;
  if (coins.length === 1) { lengths[coins[0].syms[0]] = 1; return lengths; }
  coins.sort((a, b) => (a.w - b.w) || (a.syms[0] - b.syms[0]));

  let list = coins.map((c) => ({ w: c.w, syms: c.syms }));
  for (let level = 1; level < limit; level++) {
    /** @type {{w:number,syms:number[]}[]} */
    const packages = [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      packages.push({ w: list[i].w + list[i + 1].w, syms: list[i].syms.concat(list[i + 1].syms) });
    }
    // Stable merge of the original coins with the new packages, coins first on ties.
    const merged = [];
    let a = 0, b = 0;
    while (a < coins.length || b < packages.length) {
      if (b >= packages.length || (a < coins.length && coins[a].w <= packages[b].w)) merged.push({ w: coins[a].w, syms: coins[a].syms }), a++;
      else merged.push(packages[b]), b++;
    }
    list = merged;
  }
  const take = 2 * coins.length - 2;
  for (let i = 0; i < take && i < list.length; i++) for (const s of list[i].syms) lengths[s]++;
  return lengths;
}

/**
 * Canonical Huffman codes from code lengths.
 * @param {Uint8Array} lengths
 * @returns {Int32Array}
 */
export function canonicalCodes(lengths) {
  const maxLen = lengths.reduce((m, l) => Math.max(m, l), 0);
  const counts = new Int32Array(maxLen + 1);
  for (const l of lengths) if (l) counts[l]++;
  const nextCode = new Int32Array(maxLen + 2);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) { code = (code + counts[bits - 1]) << 1; nextCode[bits] = code; }
  const codes = new Int32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) codes[i] = nextCode[lengths[i]]++;
  return codes;
}

/** @typedef {{lit: number[], dist: number[], extra: number[], bytes: [number, number]}} SymbolBlock */

/**
 * LZ77 over the input, producing symbol blocks.
 * @param {Uint8Array} input
 * @returns {SymbolBlock[]}
 */
function lz77(input) {
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(input.length).fill(-1);
  /** @type {SymbolBlock[]} */
  const blocks = [];
  /** @type {SymbolBlock} */
  let block = { lit: [], dist: [], extra: [], bytes: [0, 0] };
  const n = input.length;
  let pos = 0;

  const hashAt = (i) => (((input[i] << 10) ^ (input[i + 1] << 5) ^ input[i + 2]) & (HASH_SIZE - 1));

  while (pos < n) {
    let bestLen = 0, bestDist = 0;
    if (pos + MIN_MATCH <= n) {
      const hv = hashAt(pos);
      let candidate = head[hv];
      let chain = 0;
      const limit = Math.max(0, pos - WINDOW);
      while (candidate >= limit && candidate >= 0 && chain++ < MAX_CHAIN) {
        if (input[candidate + bestLen] === input[pos + bestLen]) {
          let l = 0;
          const max = Math.min(MAX_MATCH, n - pos);
          while (l < max && input[candidate + l] === input[pos + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = pos - candidate; if (l >= MAX_MATCH) break; }
        }
        candidate = prev[candidate];
      }
    }
    if (bestLen >= MIN_MATCH) {
      const li = lengthIndex(bestLen);
      const di = distIndex(bestDist);
      block.lit.push(257 + li);
      block.dist.push(di);
      block.extra.push(bestLen - LENGTH_BASE[li], bestDist - DIST_BASE[di]);
      for (let i = 0; i < bestLen; i++) {
        if (pos + i + MIN_MATCH <= n) { const hv = hashAt(pos + i); prev[pos + i] = head[hv]; head[hv] = pos + i; }
      }
      pos += bestLen;
    } else {
      block.lit.push(input[pos]);
      block.dist.push(-1);
      if (pos + MIN_MATCH <= n) { const hv = hashAt(pos); prev[pos] = head[hv]; head[hv] = pos; }
      pos += 1;
    }
    if (block.lit.length >= BLOCK_SYMBOLS) {
      block.bytes[1] = pos;
      blocks.push(block);
      block = { lit: [], dist: [], extra: [], bytes: [pos, pos] };
    }
  }
  block.bytes[1] = pos;
  if (block.lit.length > 0 || blocks.length === 0) blocks.push(block);
  return blocks;
}

/**
 * Run-length encode a code-length sequence into the 0..18 alphabet.
 * @param {Uint8Array} lengths
 * @returns {{sym: number[], extra: number[], freq: Int32Array}}
 */
function encodeCodeLengths(lengths) {
  const sym = [], extra = [];
  const freq = new Int32Array(19);
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    if (v === 0) {
      while (run >= 11) { const take = Math.min(run, 138); sym.push(18); extra.push(take - 11); freq[18]++; run -= take; i += take; }
      while (run >= 3) { const take = Math.min(run, 10); sym.push(17); extra.push(take - 3); freq[17]++; run -= take; i += take; }
      while (run-- > 0) { sym.push(0); extra.push(0); freq[0]++; i++; }
    } else {
      sym.push(v); extra.push(0); freq[v]++; i++; run--;
      while (run >= 3) { const take = Math.min(run, 6); sym.push(16); extra.push(take - 3); freq[16]++; run -= take; i += take; }
      while (run-- > 0) { sym.push(v); extra.push(0); freq[v]++; i++; }
    }
  }
  return { sym, extra, freq };
}

/** @param {Uint8Array} lengths @param {Int32Array} freqs @returns {number} bits */
function huffmanCost(lengths, freqs) {
  let bits = 0;
  for (let i = 0; i < lengths.length; i++) bits += lengths[i] * freqs[i];
  return bits;
}

const FIXED_LIT_LENGTHS = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST_LENGTHS = new Uint8Array(30).fill(5);

/**
 * Compress with raw DEFLATE.
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function deflateRaw(input) {
  if (input.length === 0) {
    const bw = new BitWriter();
    bw.write(1, 1); bw.write(1, 2); // final, fixed
    bw.writeCode(0, 7);             // end-of-block symbol 256 => code 0000000
    return bw.finish();
  }
  const blocks = lz77(input);
  const bw = new BitWriter();

  blocks.forEach((block, bi) => {
    const isFinal = bi === blocks.length - 1;
    const litFreq = new Int32Array(288);
    const distFreq = new Int32Array(30);
    for (let i = 0; i < block.lit.length; i++) {
      litFreq[block.lit[i]]++;
      if (block.dist[i] >= 0) distFreq[block.dist[i]]++;
    }
    litFreq[256]++; // end of block

    const litLengths = packageMerge(litFreq, 15);
    let distLengths = packageMerge(distFreq, 15);
    let numDist = 0;
    for (let i = 0; i < 30; i++) if (distLengths[i]) numDist = i + 1;
    if (numDist === 0) { distLengths = new Uint8Array(30); distLengths[0] = 1; numDist = 1; }
    let numLit = 257;
    for (let i = 0; i < 288; i++) if (litLengths[i]) numLit = Math.max(numLit, i + 1);

    const combined = new Uint8Array(numLit + numDist);
    combined.set(litLengths.subarray(0, numLit), 0);
    combined.set(distLengths.subarray(0, numDist), numLit);
    const rle = encodeCodeLengths(combined);
    const clLengths = packageMerge(rle.freq, 7);
    let numCl = 4;
    for (let i = 0; i < 19; i++) if (clLengths[CLEN_ORDER[i]]) numCl = Math.max(numCl, i + 1);

    // Extra-bit payload is identical for both Huffman variants.
    let extraBits = 0;
    for (let i = 0; i < block.lit.length; i++) {
      if (block.dist[i] >= 0) {
        extraBits += LENGTH_EXTRA[block.lit[i] - 257] + DIST_EXTRA[block.dist[i]];
      }
    }
    const dynHeaderBits = 3 + 5 + 5 + 4 + numCl * 3 + huffmanCost(clLengths, rle.freq)
      + rle.sym.reduce((s, v) => s + (v === 16 ? 2 : v === 17 ? 3 : v === 18 ? 7 : 0), 0);
    const dynBits = dynHeaderBits + huffmanCost(litLengths, litFreq) + huffmanCost(distLengths, distFreq) + extraBits;
    const fixedBits = 3 + huffmanCost(FIXED_LIT_LENGTHS, litFreq) + huffmanCost(FIXED_DIST_LENGTHS, distFreq) + extraBits;
    const rawLen = block.bytes[1] - block.bytes[0];
    const storedBits = (Math.ceil(rawLen / 65535) || 1) * (3 + 32 + 7) + rawLen * 8;

    if (storedBits <= dynBits && storedBits <= fixedBits) {
      let off = block.bytes[0];
      const end = block.bytes[1];
      do {
        const take = Math.min(65535, end - off);
        const last = isFinal && off + take >= end;
        bw.write(last ? 1 : 0, 1); bw.write(0, 2);
        bw.alignByte();
        bw.ensure(4);
        bw.buf[bw.len++] = take & 0xff; bw.buf[bw.len++] = (take >> 8) & 0xff;
        bw.buf[bw.len++] = (~take) & 0xff; bw.buf[bw.len++] = ((~take) >> 8) & 0xff;
        bw.writeBytes(input.subarray(off, off + take));
        off += take;
      } while (off < end);
      return;
    }

    const useDynamic = dynBits <= fixedBits;
    bw.write(isFinal ? 1 : 0, 1);
    bw.write(useDynamic ? 2 : 1, 2);

    let litCodes, distCodes, litLen, distLen;
    if (useDynamic) {
      bw.write(numLit - 257, 5); bw.write(numDist - 1, 5); bw.write(numCl - 4, 4);
      for (let i = 0; i < numCl; i++) bw.write(clLengths[CLEN_ORDER[i]], 3);
      const clCodes = canonicalCodes(clLengths);
      for (let i = 0; i < rle.sym.length; i++) {
        const s = rle.sym[i];
        bw.writeCode(clCodes[s], clLengths[s]);
        if (s === 16) bw.write(rle.extra[i], 2);
        else if (s === 17) bw.write(rle.extra[i], 3);
        else if (s === 18) bw.write(rle.extra[i], 7);
      }
      litLen = litLengths; distLen = distLengths;
    } else {
      litLen = FIXED_LIT_LENGTHS; distLen = FIXED_DIST_LENGTHS;
    }
    litCodes = canonicalCodes(litLen);
    distCodes = canonicalCodes(distLen);

    let ex = 0;
    for (let i = 0; i < block.lit.length; i++) {
      const sym = block.lit[i];
      bw.writeCode(litCodes[sym], litLen[sym]);
      if (block.dist[i] >= 0) {
        const li = sym - 257;
        bw.write(block.extra[ex++], LENGTH_EXTRA[li]);
        const di = block.dist[i];
        bw.writeCode(distCodes[di], distLen[di]);
        bw.write(block.extra[ex++], DIST_EXTRA[di]);
      }
    }
    bw.writeCode(litCodes[256], litLen[256]);
  });

  return bw.finish();
}

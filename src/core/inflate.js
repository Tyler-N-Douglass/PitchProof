/**
 * Raw DEFLATE decompression (RFC 1951), pure and synchronous.
 *
 * Two callers need it: the OOXML/ZIP reader in ingest (§6.5) and the emitter's
 * round-trip self-check. The artifact itself inflates with the platform's
 * `DecompressionStream`; this module is what lets the studio and the test suite
 * verify that stream's input without a browser.
 *
 * @module core/inflate
 */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * Canonical Huffman decode table: for each code length, the first code and the
 * index into a symbol array.
 * @param {Uint8Array|number[]} lengths
 * @returns {{counts: Int32Array, symbols: Int32Array}}
 */
function buildHuffman(lengths) {
  const counts = new Int32Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offsets = new Int32Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
  const symbols = new Int32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
  return { counts, symbols };
}

class BitReader {
  /** @param {Uint8Array} data */
  constructor(data) { this.data = data; this.pos = 0; this.bitBuf = 0; this.bitCount = 0; }

  /** @param {number} n @returns {number} */
  bits(n) {
    while (this.bitCount < n) {
      if (this.pos >= this.data.length) throw new Error('inflate: unexpected end of input');
      this.bitBuf |= this.data[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return v;
  }

  /** @param {{counts: Int32Array, symbols: Int32Array}} table @returns {number} */
  symbol(table) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = table.counts[len];
      if (code - first < count) return table.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: invalid Huffman code');
  }

  alignByte() { this.bitBuf = 0; this.bitCount = 0; }
}

let FIXED_LIT = null, FIXED_DIST = null;
function fixedTables() {
  if (!FIXED_LIT) {
    const lit = new Uint8Array(288);
    for (let i = 0; i < 144; i++) lit[i] = 8;
    for (let i = 144; i < 256; i++) lit[i] = 9;
    for (let i = 256; i < 280; i++) lit[i] = 7;
    for (let i = 280; i < 288; i++) lit[i] = 8;
    FIXED_LIT = buildHuffman(lit);
    FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5));
  }
  return [FIXED_LIT, FIXED_DIST];
}

/**
 * Inflate a raw DEFLATE stream.
 * @param {Uint8Array} input
 * @param {number} [expectedSize] hint used to pre-size the output buffer
 * @returns {Uint8Array}
 */
export function inflateRaw(input, expectedSize = 0) {
  const br = new BitReader(input);
  let out = new Uint8Array(Math.max(expectedSize || 0, input.length * 4, 1024));
  let o = 0;
  const ensure = (n) => {
    if (o + n <= out.length) return;
    let cap = out.length * 2;
    while (cap < o + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, o));
    out = next;
  };

  for (;;) {
    const final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.alignByte();
      if (br.pos + 4 > input.length) throw new Error('inflate: truncated stored block');
      const len = input[br.pos] | (input[br.pos + 1] << 8);
      const nlen = input[br.pos + 2] | (input[br.pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block length mismatch');
      br.pos += 4;
      ensure(len);
      out.set(input.subarray(br.pos, br.pos + len), o);
      o += len; br.pos += len;
    } else if (type === 1 || type === 2) {
      let litTable, distTable;
      if (type === 1) { [litTable, distTable] = fixedTables(); }
      else {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = br.bits(3);
        const clTable = buildHuffman(clens);
        const lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < lengths.length;) {
          const sym = br.symbol(clTable);
          if (sym < 16) lengths[i++] = sym;
          else if (sym === 16) {
            if (i === 0) throw new Error('inflate: repeat with no previous length');
            const prev = lengths[i - 1];
            let n = 3 + br.bits(2);
            while (n-- > 0) lengths[i++] = prev;
          } else if (sym === 17) { let n = 3 + br.bits(3); while (n-- > 0) lengths[i++] = 0; }
          else { let n = 11 + br.bits(7); while (n-- > 0) lengths[i++] = 0; }
        }
        litTable = buildHuffman(lengths.subarray(0, hlit));
        distTable = buildHuffman(lengths.subarray(hlit));
      }
      for (;;) {
        const sym = br.symbol(litTable);
        if (sym < 256) { ensure(1); out[o++] = sym; }
        else if (sym === 256) break;
        else {
          const li = sym - 257;
          if (li >= LENGTH_BASE.length) throw new Error('inflate: invalid length symbol');
          const length = LENGTH_BASE[li] + br.bits(LENGTH_EXTRA[li]);
          const ds = br.symbol(distTable);
          if (ds >= DIST_BASE.length) throw new Error('inflate: invalid distance symbol');
          const dist = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
          if (dist > o) throw new Error('inflate: distance beyond output start');
          ensure(length);
          let src = o - dist;
          for (let i = 0; i < length; i++) out[o++] = out[src++];
        }
      }
    } else throw new Error('inflate: invalid block type');
    if (final) break;
  }
  return out.subarray(0, o);
}

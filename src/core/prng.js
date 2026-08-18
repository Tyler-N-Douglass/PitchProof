/**
 * PCG32 (XSH-RR, 64-bit state, 32-bit output) with named substreams.
 *
 * The determinism law in §5 forbids `Math.random` anywhere in the model path.
 * Every subsystem that needs pseudo-randomness — cluster seeding, id minting,
 * jitter in a layout, property-test corpora — draws it from a named substream of
 * a single project seed, so the same project always produces the same artifact
 * and a different seed changes ids without changing rendering.
 *
 * @module core/prng
 */

const MUL = 6364136223846793005n;
const MASK64 = 0xffffffffffffffffn;
const MASK32 = 0xffffffffn;

/**
 * @param {bigint} x
 * @param {number} r
 * @returns {number}
 */
function rotr32(x, r) {
  const v = Number(x & MASK32) >>> 0;
  const rot = r & 31;
  return rot === 0 ? v : (((v >>> rot) | (v << (32 - rot))) >>> 0);
}

/** A deterministic 32-bit generator. */
export class Pcg32 {
  /**
   * @param {bigint|number|string} seed  project seed
   * @param {bigint|number|string} [stream] substream selector
   */
  constructor(seed, stream = 0) {
    this.initSeed = toU64(seed);
    this.initStream = toU64(stream);
    /** @type {bigint} */
    this.state = 0n;
    /** @type {bigint} */
    this.inc = ((this.initStream << 1n) | 1n) & MASK64;
    this.reset();
  }

  /** Restore the generator to its construction state. */
  reset() {
    this.state = 0n;
    this.step();
    this.state = (this.state + this.initSeed) & MASK64;
    this.step();
    return this;
  }

  /** @private */
  step() {
    this.state = (this.state * MUL + this.inc) & MASK64;
  }

  /**
   * Next 32-bit unsigned integer.
   * @returns {number}
   */
  nextU32() {
    const old = this.state;
    this.step();
    const xorshifted = ((old >> 18n) ^ old) >> 27n;
    const rot = Number((old >> 59n) & 31n);
    return rotr32(xorshifted, rot);
  }

  /**
   * Uniform float in [0,1) with 32 bits of entropy.
   * @returns {number}
   */
  nextFloat() {
    return this.nextU32() / 4294967296;
  }

  /**
   * Uniform integer in [0, bound) without modulo bias.
   * @param {number} bound
   * @returns {number}
   */
  nextInt(bound) {
    if (!Number.isInteger(bound) || bound <= 0) throw new Error('nextInt: bound must be a positive integer');
    const threshold = (0x100000000 % bound + 0x100000000) % bound;
    for (;;) {
      const r = this.nextU32();
      if (r >= threshold) return r % bound;
    }
  }

  /**
   * Uniform float in [min, max).
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  nextRange(min, max) {
    return min + this.nextFloat() * (max - min);
  }

  /**
   * Fisher–Yates over a copy.
   * @template T
   * @param {readonly T[]} items
   * @returns {T[]}
   */
  shuffled(items) {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * Pick one element.
   * @template T
   * @param {readonly T[]} items
   * @returns {T}
   */
  pick(items) {
    if (items.length === 0) throw new Error('pick: empty list');
    return items[this.nextInt(items.length)];
  }

  /**
   * Standard-normal deviate via Box–Muller, deterministic.
   * @returns {number}
   */
  nextGaussian() {
    let u = 0, v = 0;
    while (u === 0) u = this.nextFloat();
    while (v === 0) v = this.nextFloat();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/**
 * Coerce a seed of any accepted shape into a 64-bit unsigned value. Strings are
 * hashed with FNV-1a 64 so that `substream('kmeans')` is stable across runs and
 * across machines.
 * @param {bigint|number|string} v
 * @returns {bigint}
 */
export function toU64(v) {
  if (typeof v === 'bigint') return v & MASK64;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('toU64: non-finite seed');
    return BigInt(Math.trunc(v)) & MASK64;
  }
  if (typeof v === 'string') return fnv1a64(v);
  throw new Error('toU64: unsupported seed type');
}

/**
 * FNV-1a 64-bit over the UTF-16 code units of a string. Used only for seeding.
 * @param {string} s
 * @returns {bigint}
 */
export function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h ^= BigInt(c & 0xff); h = (h * prime) & MASK64;
    h ^= BigInt((c >> 8) & 0xff); h = (h * prime) & MASK64;
  }
  return h;
}

/**
 * A registry of named substreams over one project seed. Two subsystems drawing
 * from `substream('a')` and `substream('b')` never interfere, and the sequence a
 * subsystem sees does not depend on what any other subsystem did.
 */
export class SeedBook {
  /** @param {bigint|number|string} seed */
  constructor(seed) {
    this.seed = toU64(seed);
    /** @type {Map<string, Pcg32>} */
    this.streams = new Map();
  }

  /**
   * Get the generator for a named substream, creating it on first use.
   * @param {string} name
   * @returns {Pcg32}
   */
  stream(name) {
    let g = this.streams.get(name);
    if (!g) { g = new Pcg32(this.seed, fnv1a64(`pitchproof/substream/${name}`)); this.streams.set(name, g); }
    return g;
  }

  /**
   * A fresh generator for a named substream, independent of prior draws. Use
   * this when a computation must be reproducible in isolation (a re-run of
   * k-means over the same input, for instance).
   * @param {string} name
   * @returns {Pcg32}
   */
  fresh(name) {
    return new Pcg32(this.seed, fnv1a64(`pitchproof/substream/${name}`));
  }

  /** Reset every named substream to its construction state. */
  resetAll() {
    for (const g of this.streams.values()) g.reset();
  }
}

/** The seed used when a project does not specify one. */
export const DEFAULT_SEED = 'pitchproof-v1';

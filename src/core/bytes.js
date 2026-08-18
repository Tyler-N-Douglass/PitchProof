/**
 * Byte primitives shared by every lane. Pure, dependency-free, and identical in
 * Node and the browser so that a byte produced in a test is the same byte
 * produced in the studio.
 *
 * @module core/bytes
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** @type {Int16Array} */
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  t['='.charCodeAt(0)] = -2;
  return t;
})();

/**
 * UTF-8 encode. Uses TextEncoder when present; the manual path exists so the
 * module works in any environment and so its output is provably identical.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

/**
 * UTF-8 decode.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i += 1; }
    else if (b < 0xe0) { s += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
    else if (b < 0xf0) { s += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
    else {
      const cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      s += String.fromCodePoint(cp); i += 4;
    }
  }
  return s;
}

/**
 * Standard base64 encode with padding.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64Encode(bytes) {
  let out = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(v >> 18) & 63] + B64_CHARS[(v >> 12) & 63] + B64_CHARS[(v >> 6) & 63] + B64_CHARS[v & 63];
  }
  const rem = n - i;
  if (rem === 1) {
    const v = bytes[i] << 16;
    out += B64_CHARS[(v >> 18) & 63] + B64_CHARS[(v >> 12) & 63] + '==';
  } else if (rem === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(v >> 18) & 63] + B64_CHARS[(v >> 12) & 63] + B64_CHARS[(v >> 6) & 63] + '=';
  }
  return out;
}

/**
 * Standard base64 decode. Whitespace is ignored; invalid characters throw.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function base64Decode(str) {
  const clean = str.replace(/[\s]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)];
    if (v === -2) break;
    if (v < 0) throw new Error(`base64Decode: invalid character at ${i}`);
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

/**
 * Lowercase hex.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function fromHex(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Concatenate byte arrays.
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
export function concatBytes(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Byte length of a string once UTF-8 encoded, without allocating the buffer for
 * the common ASCII case. Used constantly by the size budgeter.
 * @param {string} str
 * @returns {number}
 */
export function utf8Length(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * Parse a `data:` URI into its parts. Returns null for anything that is not a
 * data URI — the emitter relies on this to prove no asset is a network fetch.
 * @param {string} uri
 * @returns {{ mime: string, base64: boolean, body: string, bytes: number } | null}
 */
export function parseDataUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const header = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  const base64 = /;base64$/i.test(header);
  const mime = (base64 ? header.slice(0, -7) : header) || 'text/plain';
  const bytes = base64
    ? Math.floor((body.replace(/=+$/, '').length * 3) / 4)
    : utf8Length(decodeURIComponent(body));
  return { mime, base64, body, bytes };
}

/**
 * Shared test scaffolding for the ingest lane.
 *
 * The `http` transport is injected everywhere in L3 (API.md), which is exactly
 * what lets these tests drive every network strategy without a network. The
 * stub below is the whole reason the lane is testable offline.
 */

/** A fixed clock. §5: `capturedAt` never comes from a wall-clock read. */
export const CAPTURED_AT = '2026-03-04T09:15:00.000Z';

/** @returns {() => string} */
export function fixedClock(value = CAPTURED_AT) {
  return () => value;
}

/**
 * Build a stub `http` matching the injected contract:
 * `(url, init) => Promise<{ok, status, text(), bytes(), headers}>`.
 *
 * @param {Record<string, {status?: number, body?: string|Uint8Array, headers?: Record<string,string>, throws?: string}>} routes
 * @param {{onRequest?: (url: string, init: object) => void, fallbackStatus?: number}} [options]
 */
export function makeHttp(routes, options = {}) {
  /** @type {string[]} */
  const calls = [];
  const http = async (url, init = {}) => {
    calls.push(url);
    if (options.onRequest) options.onRequest(url, init);
    const route = routes[url];
    if (!route) {
      return {
        ok: false,
        status: options.fallbackStatus === undefined ? 404 : options.fallbackStatus,
        url,
        async text() { return ''; },
        async bytes() { return new Uint8Array(0); },
      };
    }
    if (route.throws) throw new TypeError(route.throws);
    const status = route.status === undefined ? 200 : route.status;
    const body = route.body === undefined ? '' : route.body;
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: new Map(Object.entries(route.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
      async text() { return body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body); },
      async bytes() { return bytes; },
    };
  };
  http.calls = calls;
  return http;
}

/** A transport that refuses everything the way a CORS-blocked browser does. */
export function corsBlockedHttp() {
  const http = async () => { throw new TypeError('Failed to fetch'); };
  return http;
}

/**
 * @param {string} s
 * @returns {Uint8Array}
 */
export function bytesOf(s) { return new TextEncoder().encode(s); }

/**
 * @param {Uint8Array} b
 * @returns {string}
 */
export function textOf(b) { return new TextDecoder().decode(b); }

/**
 * A tiny valid PNG, built without a dependency, for asset round-trips.
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array}
 */
export function tinyPng(w = 2, h = 2) {
  // 8-bit RGB, one filter byte per row, stored uncompressed inside a zlib
  // container so the fixture needs no compressor.
  const stride = w * 3;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = 59; raw[o + 1] = 46; raw[o + 2] = 234;
    }
  }
  const stored = storedDeflate(raw);
  const zlib = new Uint8Array(stored.length + 6);
  zlib[0] = 0x78; zlib[1] = 0x01;
  zlib.set(stored, 2);
  const sum = adler32(raw);
  zlib[zlib.length - 4] = (sum >>> 24) & 0xff;
  zlib[zlib.length - 3] = (sum >>> 16) & 0xff;
  zlib[zlib.length - 2] = (sum >>> 8) & 0xff;
  zlib[zlib.length - 1] = sum & 0xff;

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array(0)),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function storedDeflate(data) {
  const out = new Uint8Array(data.length + 5);
  out[0] = 1;
  out[1] = data.length & 0xff;
  out[2] = (data.length >> 8) & 0xff;
  out[3] = ~data.length & 0xff;
  out[4] = (~data.length >> 8) & 0xff;
  out.set(data, 5);
  return out;
}

/**
 * @param {Uint8Array} data
 * @returns {number}
 */
function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * @param {string} tag
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function chunk(tag, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = tag.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC_TABLE[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

/**
 * Base64 without a dependency, for building HAR and MHTML fixtures in-test.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += chars[(v >> 18) & 63] + chars[(v >> 12) & 63] + chars[(v >> 6) & 63] + chars[v & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const v = bytes[i] << 16;
    out += `${chars[(v >> 18) & 63]}${chars[(v >> 12) & 63]}==`;
  } else if (rem === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${chars[(v >> 18) & 63]}${chars[(v >> 12) & 63]}${chars[(v >> 6) & 63]}=`;
  }
  return out;
}

/** A small but structurally real page, used by the archive round-trips. */
export const SAMPLE_PAGE = `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>Northwind &mdash; Approval chains</title>
<meta name="description" content="Every change has a named reviewer.">
<meta property="og:image" content="https://northwind.example/og.png">
<link rel="canonical" href="https://northwind.example/approvals">
<link rel="stylesheet" href="page_files/site.css">
</head>
<body>
<header><nav><a href="/">Home</a><a href="/approvals">Approvals</a></nav></header>
<main>
<h1>Approval chains</h1>
<p>Every change has a named reviewer, and the trail survives the audit.
<ul><li>Named reviewers<li>Immutable trail</ul>
<img src="page_files/chain.png" alt="Approval chain">
</main>
<footer><p>&copy; 2026 Northwind</p></footer>
<script src="page_files/app.js"></script>
</body>
</html>`;

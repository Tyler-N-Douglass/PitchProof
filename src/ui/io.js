/**
 * Local file in and out for the studio.
 *
 * Both directions are strictly local: a file the user picked, and a file the
 * browser saves. Nothing here reaches a network, and nothing here is reachable
 * from an emitted artifact — the artifact contains only `src/runtime/**` plus
 * the model, and §13's scanner re-checks that on every emit.
 *
 * Every function degrades rather than throwing when the host does not provide
 * the API, because §16 says a save must never fail silently: the caller gets a
 * `Result` it can put in front of the user.
 *
 * @module ui/io
 */

import { ok, err } from '../core/result.js';

/**
 * Read the files a `<input type=file>` or a drop event produced. Text-ish files
 * come back with `text`; everything comes back with `bytes`, so an importer can
 * choose.
 * @param {ArrayLike<any>} fileList
 * @returns {Promise<{name: string, mime: string, bytes: Uint8Array, text: string|null, size: number}[]>}
 */
export async function readFiles(fileList) {
  const files = Array.from(fileList || []);
  const out = [];
  for (const file of files) {
    const bytes = typeof file.arrayBuffer === 'function'
      ? new Uint8Array(await file.arrayBuffer())
      : new Uint8Array();
    out.push({
      name: file.name || 'file',
      mime: file.type || guessMime(file.name || ''),
      bytes,
      text: isTextual(file.name || '', file.type || '') ? decodeUtf8(bytes) : null,
      size: bytes.length,
    });
  }
  return out;
}

/** @param {Uint8Array} bytes @returns {string} */
function decodeUtf8(bytes) {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * @param {string} name
 * @param {string} mime
 * @returns {boolean}
 */
export function isTextual(name, mime) {
  if (/^text\//.test(mime) || mime === 'application/json') return true;
  return /\.(html?|htm|har|mhtml|mht|json|txt|md|css|svg|xml)$/i.test(name);
}

/**
 * @param {string} name
 * @returns {string}
 */
export function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const table = {
    html: 'text/html', htm: 'text/html', json: 'application/json', har: 'application/json',
    mhtml: 'message/rfc822', mht: 'message/rfc822', txt: 'text/plain', md: 'text/markdown',
    css: 'text/css', svg: 'image/svg+xml', xml: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return table[ext] || 'application/octet-stream';
}

/**
 * Hand a file to the browser to save. Returns a `Result` rather than throwing,
 * so a host that blocks downloads produces a sentence the user can act on
 * instead of a dead button.
 * @param {object} args
 * @param {Document} args.document
 * @param {any} args.window
 * @param {string} args.filename
 * @param {string} args.text
 * @param {string} [args.mime]
 * @returns {{ok: true, value: {filename: string, bytes: number}} | {ok: false, error: string}}
 */
export function downloadText({ document: doc, window: view, filename, text, mime = 'text/plain' }) {
  const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length;
  const urlApi = view && view.URL ? view.URL : (typeof URL !== 'undefined' ? URL : null);
  if (!doc || !doc.createElement || !urlApi || typeof urlApi.createObjectURL !== 'function' || typeof Blob !== 'function') {
    return err('This browser will not let a page save a file. Copy the contents from the panel instead.');
  }
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const href = urlApi.createObjectURL(blob);
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('download', filename);
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    if (view && typeof view.setTimeout === 'function') {
      view.setTimeout(() => { try { urlApi.revokeObjectURL(href); } catch { /* already gone */ } }, 30000);
    }
    return ok({ filename, bytes });
  } catch (e) {
    return err(`The download did not start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * A filename that is safe on every platform and still says what the file is.
 * @param {string} base
 * @param {string} extension  including the dot
 * @returns {string}
 */
export function safeFilename(base, extension) {
  const cleaned = String(base || 'pitchproof')
    .normalize('NFKD')
    .replace(/[^\w\s.-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${cleaned || 'pitchproof'}${extension}`;
}

/**
 * Open the host file picker without keeping a hidden input in the tree. The
 * studio also renders real `<input type=file>` controls, which is what keeps
 * import keyboard-reachable; this is the command-palette route to the same
 * thing.
 * @param {object} args
 * @param {Document} args.document
 * @param {string} [args.accept]
 * @param {boolean} [args.multiple]
 * @returns {Promise<any[]>} the chosen files, or an empty list
 */
export function pickFiles({ document: doc, accept, multiple = true }) {
  return new Promise((resolve) => {
    if (!doc || !doc.createElement) { resolve([]); return; }
    const input = doc.createElement('input');
    input.setAttribute('type', 'file');
    if (accept) input.setAttribute('accept', accept);
    if (multiple) input.setAttribute('multiple', '');
    input.style.display = 'none';
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      try { doc.body.removeChild(input); } catch { /* already detached */ }
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files || [])));
    input.addEventListener('cancel', () => finish([]));
    doc.body.appendChild(input);
    input.click();
  });
}

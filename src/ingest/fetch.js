/**
 * Fetch strategies (§6), in the order the spec sets them out.
 *
 * The product law this module exists to serve: **ingest degrades gracefully and
 * never dead-ends.** A CORS refusal is the expected outcome for most enterprise
 * sites, not an error worth alarming a seller about ten minutes before a pitch.
 * So every strategy returns a `Result`, a failure names the next thing to try,
 * and nothing here throws at the caller.
 *
 * Every network call goes through an **injected** `http` function
 * (`(url, init) => Promise<{ok, status, text(), bytes()}>`). There is no global
 * `fetch` reference in this lane, which is what lets the test suite drive every
 * strategy with a stub and lets the studio decide its own transport.
 *
 * @module ingest/fetch
 */

import { ok, err } from '../core/result.js';
import { htmlCapture, makeCapture, now, sniffMime, mimeForName, resolveUrl, originOf } from './capture.js';
import { importOoxml } from './ooxml.js';
import { importPdf } from './pdf/index.js';
import { importImage } from './image.js';
import { importHar } from './har.js';
import { importMhtml } from './mhtml.js';
import { importSavedPage } from './saved-page.js';
import { importHtmlText, importManual } from './paste.js';
import { collectSubresources, applySubresourceReport, SUBRESOURCE_LIMITS } from './subresources.js';
import { parseRobots, emptyRobots } from './robots.js';

/**
 * @typedef {import('./capture.js').RawCapture} RawCapture
 * @typedef {{ok: boolean, status?: number, text?: () => Promise<string>, bytes?: () => Promise<Uint8Array>, headers?: any, url?: string}} HttpResponse
 * @typedef {(url: string, init?: object) => Promise<HttpResponse>} HttpFn
 */

/**
 * @typedef {object} Strategy
 * @property {string} id
 * @property {number} order        unique, ascending
 * @property {number} specOrder    the §6 numbered strategy this belongs to
 * @property {string} label
 * @property {string} describe
 * @property {'network'|'file'|'paste'|'manual'} kind
 * @property {boolean} automatic   true when ingest may try it without the user acting
 * @property {string[]} accepts    file extensions, for the file-drop surfaces
 * @property {string[]} requires   injected dependencies the strategy needs
 * @property {(input: any, deps: any) => any} run
 */

/** The strategies, in §6 order. Exported as data so the studio can render it. */
export function fetchStrategies() {
  return [
    {
      id: 'direct-fetch',
      order: 1,
      specOrder: 1,
      label: 'Direct fetch',
      describe: 'Ask the browser for the page. Fast when it works; most enterprise sites refuse it with CORS, which is normal and not a failure of the tool.',
      kind: 'network',
      automatic: true,
      accepts: [],
      requires: ['http', 'clock'],
      run: (url, deps) => fetchDirect(url, deps),
    },
    {
      id: 'cors-proxy',
      order: 2,
      specOrder: 2,
      label: 'Your CORS proxy',
      describe: 'Route the request through a proxy base URL you supply and trust. Empty by default — PitchProof ships no third-party proxy.',
      kind: 'network',
      automatic: true,
      accepts: [],
      requires: ['http', 'clock', 'proxyBase'],
      run: (url, deps) => fetchViaProxy(url, deps),
    },
    {
      id: 'saved-page',
      order: 3,
      specOrder: 3,
      label: 'Saved page',
      describe: 'Save the page from your browser (Complete) and drop the .html file together with its _files folder.',
      kind: 'file',
      automatic: false,
      accepts: ['.html', '.htm'],
      requires: ['clock'],
      run: (files, deps) => importSavedPage(files, deps),
    },
    {
      id: 'har',
      order: 4,
      specOrder: 3,
      label: 'HAR capture',
      describe: 'Export a HAR from your browser devtools Network panel. Carries the page and every asset it loaded.',
      kind: 'file',
      automatic: false,
      accepts: ['.har'],
      requires: ['clock'],
      run: (text, deps) => importHar(text, deps),
    },
    {
      id: 'mhtml',
      order: 5,
      specOrder: 3,
      label: 'MHTML archive',
      describe: 'A single-file web archive (.mhtml / .mht). Chrome and Edge write these from Save As.',
      kind: 'file',
      automatic: false,
      accepts: ['.mhtml', '.mht'],
      requires: ['clock'],
      run: (text, deps) => importMhtml(text, deps),
    },
    {
      id: 'paste-html',
      order: 6,
      specOrder: 4,
      label: 'Paste HTML',
      describe: 'View source, copy, paste. Works when nothing else does, and needs no network at all.',
      kind: 'paste',
      automatic: false,
      accepts: [],
      requires: ['clock'],
      run: (html, deps) => importHtmlText(html, deps),
    },
    {
      id: 'file-import',
      order: 7,
      specOrder: 5,
      label: 'File import',
      describe: 'Drop a .docx, .pptx, .pdf or an image. Text, structure and embedded media are read directly — no conversion service, no upload.',
      kind: 'file',
      automatic: false,
      accepts: ['.docx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'],
      requires: ['clock'],
      run: (file, deps) => ingestFile(file, deps),
    },
    {
      id: 'manual-entry',
      order: 8,
      specOrder: 6,
      label: 'Type it in',
      describe: 'Enter the content by hand. Always available, never blocked, and the only strategy that cannot fail.',
      kind: 'manual',
      automatic: false,
      accepts: [],
      requires: ['clock'],
      run: (input, deps) => importManual(input, deps),
    },
  ];
}

/**
 * The strategy record for an id.
 * @param {string} id
 * @returns {Strategy|null}
 */
export function strategyById(id) {
  return fetchStrategies().find((s) => s.id === id) || null;
}

/**
 * A short, non-alarming description of what to try next after a network
 * strategy declined. §6: "do not surface a scary error as the primary
 * experience."
 * @param {string[]} [tried]
 * @returns {string}
 */
export function nextStepsMessage(tried = []) {
  const remaining = fetchStrategies().filter((s) => !tried.includes(s.id) && !s.automatic);
  const names = remaining.map((s) => s.label);
  if (!names.length) return 'Enter the content by hand — that path is always open.';
  return `Still available: ${names.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Network strategies
// ---------------------------------------------------------------------------

/**
 * Build the proxied URL from a user-supplied proxy base.
 *
 * Three shapes are accepted, because that covers every self-hosted proxy anyone
 * actually runs:
 *   - `https://proxy.example/fetch?url={url}`  → `{url}` is replaced, encoded
 *   - `https://proxy.example/fetch?url=`       → the encoded URL is appended
 *   - `https://proxy.example/`                 → the raw URL is appended
 *
 * @param {string} proxyBase
 * @param {string} url
 * @returns {string}
 */
export function proxyUrl(proxyBase, url) {
  const base = String(proxyBase || '').trim();
  if (!base) return url;
  if (base.includes('{url}')) return base.replace('{url}', encodeURIComponent(url));
  if (base.includes('{rawurl}')) return base.replace('{rawurl}', url);
  if (/[?&]$|=$/.test(base)) return base + encodeURIComponent(url);
  if (base.endsWith('/')) return base + url;
  return `${base}/${url}`;
}

/**
 * Read a response as text, tolerating a transport that only offers bytes.
 * @param {HttpResponse} res
 * @returns {Promise<string>}
 */
async function responseText(res) {
  if (typeof res.text === 'function') return res.text();
  if (typeof res.bytes === 'function') {
    const bytes = await res.bytes();
    return new TextDecoder().decode(bytes);
  }
  throw new Error('http transport returned neither text() nor bytes()');
}

/**
 * @param {HttpResponse} res
 * @returns {Promise<Uint8Array>}
 */
async function responseBytes(res) {
  if (typeof res.bytes === 'function') return res.bytes();
  if (typeof res.text === 'function') return new TextEncoder().encode(await res.text());
  throw new Error('http transport returned neither text() nor bytes()');
}

/**
 * @param {HttpResponse} res
 * @returns {string}
 */
function contentTypeOf(res) {
  const headers = res && res.headers;
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return String(headers.get('content-type') || '').toLowerCase();
    const direct = headers['content-type'] || headers['Content-Type'];
    if (direct) return String(direct).toLowerCase();
  } catch { /* a hostile header bag is not worth an exception */ }
  return '';
}

/**
 * Turn one successful response into a capture, dispatching on content type so a
 * URL that points at a PDF or a deck imports as a document rather than as
 * mojibake.
 * @param {HttpResponse} res
 * @param {string} url
 * @param {string} strategy
 * @param {{clock: () => string}} deps
 * @returns {Promise<import('../core/result.js').Result<RawCapture>>}
 */
async function captureResponse(res, url, strategy, deps) {
  const contentType = contentTypeOf(res);
  const byName = mimeForName(url);
  const looksBinary = /pdf|officedocument|^image\//.test(contentType)
    || /pdf|officedocument|^image\//.test(byName);

  if (looksBinary) {
    const bytes = await responseBytes(res);
    const mime = sniffMime(bytes, url);
    const name = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || 'download');
    let result;
    if (mime === 'application/pdf') result = importPdf(bytes, { name, clock: deps.clock, sourceUrl: url });
    else if (mime.includes('officedocument')) result = importOoxml(bytes, { name, clock: deps.clock, sourceUrl: url });
    else result = importImage(bytes, { name, mime, clock: deps.clock, sourceUrl: url });
    if (!result.ok) return result;
    return ok({ ...result.value, sourceUrl: url, strategy });
  }

  const text = await responseText(res);
  const capture = htmlCapture(text, {
    sourceUrl: url,
    capturedAt: now(deps),
    strategy,
    meta: contentType ? { 'http.contentType': contentType } : {},
  });
  if (typeof res.status === 'number') capture.meta['http.status'] = String(res.status);
  if (res.url && res.url !== url) capture.meta['http.finalUrl'] = String(res.url);

  // A document on its own is not a capture (§1.2, §7, §8): the brand engine
  // needs the stylesheet, and every media block needs bytes behind it. Fetching
  // the sub-resources is best-effort — a failure here never loses the document.
  await attachSubresources(capture, url, strategy, deps);
  return ok(capture);
}

/**
 * Fetch and attach the sub-resources a captured document references, through
 * the same route the document took.
 *
 * §6's degradation law applies in full: anything that goes wrong here is
 * recorded in the capture's report and the document capture still succeeds.
 *
 * @param {import('./capture.js').RawCapture} capture
 * @param {string} url
 * @param {string} strategy
 * @param {{http?: HttpFn, clock: () => string, proxyBase?: string, subresources?: boolean|object, robotsText?: string|null}} deps
 * @returns {Promise<void>}
 */
export async function attachSubresources(capture, url, strategy, deps) {
  if (deps.subresources === false) {
    capture.meta['subresources.skippedReasons'] = 'disabled by the caller';
    return;
  }
  if (typeof deps.http !== 'function' || !capture.doc) return;

  /** @type {any} */
  const limits = { ...SUBRESOURCE_LIMITS, ...(typeof deps.subresources === 'object' && deps.subresources ? deps.subresources : {}) };

  // Sub-resources travel the same road as the document: a capture that needed
  // the user's proxy must not then try to reach its stylesheet directly.
  const viaProxy = strategy === 'cors-proxy' && (deps.proxyBase || '').trim();
  const fetchUrl = viaProxy
    ? (target, init) => /** @type {HttpFn} */ (deps.http)(proxyUrl(/** @type {string} */ (deps.proxyBase), target), init)
    : /** @type {HttpFn} */ (deps.http);

  let robots = emptyRobots();
  if (limits.respectRobots) {
    robots = await readRobots(url, fetchUrl, deps);
  }

  try {
    const { assets, report } = await collectSubresources({
      doc: capture.doc,
      baseUrl: url,
      fetchUrl,
      robots,
      limits,
    });
    capture.assets = capture.assets.concat(assets);
    applySubresourceReport(capture, report);
  } catch (e) {
    // Collection is an enhancement; the document capture already succeeded.
    capture.meta['subresources.error'] = e instanceof Error ? e.message : String(e);
    capture.meta['subresources.fetched'] = capture.meta['subresources.fetched'] || '0';
  }
}

/**
 * Read `robots.txt` once per ingest, best-effort. An unreadable file allows
 * everything, which is what the standard says and what keeps ingest working on
 * the many sites that have none.
 *
 * The caller may supply `robotsText` when it already has it, so sitemap assist
 * and sub-resource collection need not fetch it twice.
 *
 * @param {string} url
 * @param {HttpFn} fetchUrl
 * @param {{robotsText?: string|null}} deps
 * @returns {Promise<import('./robots.js').Robots>}
 */
async function readRobots(url, fetchUrl, deps) {
  if (typeof deps.robotsText === 'string') return parseRobots(deps.robotsText);
  const origin = originOf(url);
  if (!origin) return emptyRobots();
  try {
    const res = await fetchUrl(`${origin}/robots.txt`, { method: 'GET' });
    if (!res || !res.ok) return emptyRobots();
    return parseRobots(await responseText(res));
  } catch {
    return emptyRobots();
  }
}

/**
 * The message for something that is not a fetchable address. It never echoes an
 * internal value back at the user: a `[object Object]` in a failure message is
 * a defect, not a diagnostic.
 * @param {unknown} url
 * @returns {string}
 */
function badUrlMessage(url) {
  const printable = typeof url === 'string' && url.trim() ? `"${url.trim().slice(0, 80)}"` : '';
  return printable
    ? `${printable} is not an address I can fetch. A full address including https:// works best.`
    : 'No address was given. Paste the full page URL, including https://.';
}

/**
 * Strategy 1 — direct fetch.
 * @param {string} url
 * @param {{http?: HttpFn, clock: () => string}} deps
 * @returns {Promise<import('../core/result.js').Result<RawCapture>>}
 */
export async function fetchDirect(url, deps) {
  const target = typeof url === 'string' ? resolveUrl(null, url) : null;
  if (!target) return err(badUrlMessage(url));
  if (typeof deps.http !== 'function') {
    return err('No network transport is configured, so the direct fetch was skipped. ' + nextStepsMessage(['direct-fetch']));
  }
  try {
    const res = await deps.http(target, { method: 'GET', redirect: 'follow' });
    if (!res || !res.ok) {
      const status = res && typeof res.status === 'number' ? res.status : 0;
      return err(`The site answered ${status || 'nothing'} for a direct request.`, { status, url: target });
    }
    return await captureResponse(res, target, 'direct-fetch', deps);
  } catch (e) {
    return err('The browser would not read that page directly — usually CORS, which most sites set. Nothing is wrong on your side.', {
      url: target,
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Strategy 2 — the user's own CORS proxy. Empty by default; PitchProof never
 * ships a hardcoded third-party proxy (§6.2).
 * @param {string} url
 * @param {{http?: HttpFn, clock: () => string, proxyBase?: string}} deps
 * @returns {Promise<import('../core/result.js').Result<RawCapture>>}
 */
export async function fetchViaProxy(url, deps) {
  const base = (deps.proxyBase || '').trim();
  if (!base) {
    return err('No CORS proxy is configured. Paste a proxy base URL you trust in Settings to enable this route.');
  }
  const target = typeof url === 'string' ? resolveUrl(null, url) : null;
  if (!target) return err(badUrlMessage(url));
  if (typeof deps.http !== 'function') {
    return err('No network transport is configured, so the proxy route was skipped. ' + nextStepsMessage(['direct-fetch', 'cors-proxy']));
  }
  const proxied = proxyUrl(base, target);
  try {
    const res = await deps.http(proxied, { method: 'GET', redirect: 'follow' });
    if (!res || !res.ok) {
      const status = res && typeof res.status === 'number' ? res.status : 0;
      return err(`Your proxy answered ${status || 'nothing'}.`, { status, url: proxied });
    }
    const result = await captureResponse(res, target, 'cors-proxy', deps);
    if (result.ok) result.value.meta['http.proxied'] = 'true';
    return result;
  } catch (e) {
    return err('Your proxy did not answer. Check the base URL in Settings.', {
      url: proxied,
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Strategies 1 → 2, in order, degrading silently.
 *
 * The failure `Result` is written to be read by a person under time pressure:
 * it says what happened, that it is normal, and what to do next.
 *
 * @param {string} url
 * @param {{proxyBase?: string, http?: HttpFn, clock: () => string}} deps
 * @returns {Promise<import('../core/result.js').Result<RawCapture>>}
 */
export async function ingestUrl(url, deps = /** @type {any} */ ({})) {
  /** @type {{strategy: string, error: string}[]} */
  const attempts = [];
  try {
    now(deps);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  const direct = await fetchDirect(url, deps);
  if (direct.ok) return direct;
  attempts.push({ strategy: 'direct-fetch', error: direct.error });

  if ((deps.proxyBase || '').trim()) {
    const viaProxy = await fetchViaProxy(url, deps);
    if (viaProxy.ok) return viaProxy;
    attempts.push({ strategy: 'cors-proxy', error: viaProxy.error });
  }

  const tried = attempts.map((a) => a.strategy);
  return err(
    `Could not read ${url} over the network. ${attempts[0].error} ${nextStepsMessage(tried)}`,
    { attempts, url },
  );
}

// ---------------------------------------------------------------------------
// File dispatch
// ---------------------------------------------------------------------------

/**
 * Strategy 5 — import one dropped file, choosing the importer from its bytes
 * rather than from its name, so a mislabelled file still works.
 *
 * @param {{name?: string, bytes?: Uint8Array, text?: string, mime?: string}} file
 * @param {{clock: () => string, sourceUrl?: string|null}} deps
 * @returns {import('../core/result.js').Result<RawCapture|RawCapture[]>|Promise<any>}
 */
export function ingestFile(file, deps) {
  if (!file) return err('No file was handed to the importer.');
  const name = file.name || 'file';
  const lower = name.toLowerCase();
  const bytes = file.bytes instanceof Uint8Array
    ? file.bytes
    : (typeof file.text === 'string' ? new TextEncoder().encode(file.text) : null);
  if (!bytes) return err(`"${name}" arrived with no content.`);

  const mime = file.mime && file.mime !== 'application/octet-stream' ? file.mime : sniffMime(bytes, name);
  const asText = () => (typeof file.text === 'string' ? file.text : new TextDecoder().decode(bytes));

  if (lower.endsWith('.har')) return importHar(asText(), deps);
  if (lower.endsWith('.mhtml') || lower.endsWith('.mht')) return importMhtml(asText(), deps);
  if (mime === 'application/pdf') return importPdf(bytes, { name, clock: deps.clock, sourceUrl: deps.sourceUrl });
  if (mime.includes('officedocument') || mime === 'application/zip') {
    return importOoxml(bytes, { name, clock: deps.clock, sourceUrl: deps.sourceUrl });
  }
  if (mime.startsWith('image/')) return importImage(bytes, { name, mime, clock: deps.clock, sourceUrl: deps.sourceUrl });
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return importHtmlText(asText(), { clock: deps.clock, sourceUrl: deps.sourceUrl });
  }
  if (mime.startsWith('text/') || mime === 'application/json') {
    return importManual({ title: name, text: asText() }, deps);
  }
  return err(`PitchProof does not read ${mime} files. Supported: .html, .har, .mhtml, .docx, .pptx, .pdf and images.`);
}

/**
 * Strategy 5, plural — a whole dropped folder. Saved pages are detected and
 * routed to the saved-page importer with their asset folder attached; every
 * other file is imported on its own.
 *
 * @param {{name?: string, bytes?: Uint8Array, text?: string, mime?: string}[]} files
 * @param {{clock: () => string}} deps
 * @returns {Promise<import('../core/result.js').Result<RawCapture[]>>}
 */
export async function ingestFiles(files, deps) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return err('No files were dropped.');
  const htmlFiles = list.filter((f) => /\.x?html?$/i.test(f.name || ''));
  /** @type {RawCapture[]} */
  const captures = [];
  /** @type {string[]} */
  const problems = [];

  if (htmlFiles.length) {
    const saved = await importSavedPage(list, deps);
    if (saved.ok) captures.push(...saved.value);
    else problems.push(saved.error);
  }
  for (const file of list) {
    if (/\.x?html?$/i.test(file.name || '')) continue;
    if (/_files\//.test(file.name || '') && htmlFiles.length) continue;   // already attached as an asset
    const result = await ingestFile(file, deps);
    if (result.ok) {
      if (Array.isArray(result.value)) captures.push(...result.value);
      else captures.push(result.value);
    } else {
      problems.push(`${file.name}: ${result.error}`);
    }
  }
  if (!captures.length) {
    return err(problems.length ? problems.join(' ') : 'Nothing in that drop could be imported.', { problems });
  }
  return ok(captures);
}

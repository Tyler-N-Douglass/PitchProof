/**
 * The artifact document (§13).
 *
 * One `.html` file, everything inline, nothing to fetch. The order of the
 * document is the §12 cold-boot budget expressed as markup:
 *
 *   1. `<style>` in the head — inline, so there is no stylesheet to wait for.
 *   2. `#pp-stage-root`, carrying the **opening beat already rendered as static
 *      HTML** and marked `data-pp-prerendered`. This is the paint. It happens
 *      before a line of JavaScript has run, and `RuntimeHost.attach()` adopts
 *      the markup instead of replacing it, so the artifact never flashes.
 *   3. The payloads, as inert `<script type="application/octet-stream">`
 *      elements — after the stage root, so nothing about them delays the paint.
 *   4. The presentation runtime, then the boot script, which reassembles the
 *      model and makes the keyboard work.
 *
 * §18.5 governs every string written here: nothing in the artifact claims a
 * capability was performed live, because nothing in the artifact performs one.
 *
 * @module emit/document
 */

import { escapeText, escapeAttr } from '../core/vdom.js';
import { stableStringify } from '../core/hash.js';
import { encodePayload } from './model.js';

/** The element the runtime mounts into and the emitter pre-renders. */
export const STAGE_ROOT_ID = 'pp-stage-root';
/** Attribute marking the pre-rendered opening beat, read by `RuntimeHost`. */
export const PRERENDERED_ATTR = 'data-pp-prerendered';
/** Element ids of the two inert payload blocks. */
export const MODEL_ELEMENT_ID = 'pp-model';
export const MEDIA_ELEMENT_ID = 'pp-media';
/** MIME type that makes a `<script>` inert: a browser will not execute it. */
export const INERT_SCRIPT_TYPE = 'application/octet-stream';

/**
 * A sequence that would end a `<script>` or `<style>` element early. Inline
 * script cannot be escaped generically — `<\/script` is valid inside a string
 * literal and invalid in a regex — so the emitter refuses rather than guessing.
 */
const ELEMENT_BREAKOUT = /<\/\s*(script|style)\b|<!--/i;

/**
 * @param {string} text
 * @param {string} what
 */
function assertNoBreakout(text, what) {
  const m = ELEMENT_BREAKOUT.exec(String(text));
  if (m) {
    throw new Error(
      `emit: ${what} contains ${JSON.stringify(m[0])} at offset ${m.index}, which would close its element early. `
      + 'Inline script cannot be escaped safely in every position, so the emitter refuses rather than corrupting the artifact.',
    );
  }
}

/**
 * Assemble the artifact.
 *
 * The declared surface takes `{runtimeJs, runtimeCss, themeCss, proof,
 * firstPaintHtml}`; everything else is optional and is derived from `proof`
 * when it is absent, so the five-argument call in `API.md` produces a complete,
 * working file on its own.
 *
 * @param {object} args
 * @param {string} args.runtimeJs
 * @param {string} args.runtimeCss
 * @param {string} args.themeCss
 * @param {import('../core/contracts.d.ts').Proof} args.proof
 * @param {string} args.firstPaintHtml
 * @param {string} [args.userCss]        stylesheet supplied by the user, applied last
 * @param {string} [args.fontCss]        `@font-face` rules for licence-asserted faces
 * @param {string} [args.payload]        base64 model payload
 * @param {string} [args.mediaText]      media table, one data URI per line
 * @param {'deflate'|'raw'} [args.mode]
 * @param {string} [args.bootSource]     decode functions for the chosen variant
 * @param {Record<string, unknown>} [args.manifest]
 * @returns {string}
 */
export function inlineRuntime(args) {
  const {
    runtimeJs = '', runtimeCss = '', themeCss = '', proof, firstPaintHtml = '',
    userCss = '', fontCss = '',
  } = args;

  let { payload, mediaText, mode, bootSource } = args;
  if (payload === undefined || mediaText === undefined || mode === undefined || bootSource === undefined) {
    const encoded = encodePayload(proof);
    payload = encoded.payload;
    mediaText = encoded.mediaText;
    mode = encoded.mode;
    bootSource = encoded.bootSource;
  }

  assertNoBreakout(runtimeJs, 'the runtime bundle');
  assertNoBreakout(bootSource, 'the artifact boot source');
  assertNoBreakout(runtimeCss, 'the runtime stylesheet');
  assertNoBreakout(themeCss, 'the brand theme');
  assertNoBreakout(userCss, 'the user stylesheet');
  assertNoBreakout(fontCss, 'the embedded font rules');
  assertNoBreakout(payload, 'the model payload');
  assertNoBreakout(mediaText, 'the media table');

  const prospect = (proof && proof.prospectName) || 'Proof';
  const lang = documentLanguage(proof);
  const manifest = {
    generator: 'PitchProof',
    schemaVersion: proof ? proof.schemaVersion : 1,
    proofId: proof ? proof.id : null,
    compression: mode,
    ...(args.manifest || {}),
  };

  const styles = [
    runtimeCss ? `<style id="pp-runtime-css">\n${runtimeCss}\n</style>` : '',
    fontCss ? `<style id="pp-font-css">\n${fontCss}\n</style>` : '',
    themeCss ? `<style id="pp-theme-css">\n${themeCss}\n</style>` : '',
    userCss ? `<style id="pp-user-css">\n${userCss}\n</style>` : '',
  ].filter(Boolean).join('\n');

  const boot = [
    '(function () {',
    "'use strict';",
    bootSource,
    `ppBootArtifact({ modelId: ${JSON.stringify(MODEL_ELEMENT_ID)}, mediaId: ${JSON.stringify(MEDIA_ELEMENT_ID)}, mode: ${JSON.stringify(mode)}, document: document, window: window });`,
    '})();',
  ].join('\n');

  return [
    '<!doctype html>',
    `<html lang="${escapeAttr(lang)}" data-pp-artifact="1">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeText(prospect)}</title>`,
    styles,
    '</head>',
    '<body>',
    `<div id="${STAGE_ROOT_ID}" ${PRERENDERED_ATTR}>${firstPaintHtml}</div>`,
    '<noscript><p class="pp-noscript">The opening scene is shown above. Moving through this proof needs JavaScript; nothing else about it needs anything at all.</p></noscript>',
    `<script id="${MODEL_ELEMENT_ID}" type="${INERT_SCRIPT_TYPE}">${payload}</script>`,
    `<script id="${MEDIA_ELEMENT_ID}" type="${INERT_SCRIPT_TYPE}">${mediaText}</script>`,
    `<script id="pp-manifest" type="application/json">${jsonForScript(manifest)}</script>`,
    `<script id="pp-runtime">\n${runtimeJs}\n</script>`,
    `<script id="pp-boot">\n${boot}\n</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The document language. Taken from the first specimen that declares a locale,
 * because the artifact is presenting that prospect's content, not ours.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {string}
 */
export function documentLanguage(proof) {
  const specimens = (proof && proof.specimens) || [];
  for (const s of specimens) {
    if (typeof s.locale === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(s.locale)) return s.locale;
  }
  return 'en';
}

/**
 * JSON safe to place inside a `<script>` element.
 * @param {unknown} value
 * @returns {string}
 */
export function jsonForScript(value) {
  return stableStringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

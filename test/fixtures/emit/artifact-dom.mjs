/**
 * Just enough DOM for the artifact's own boot-time media reader.
 *
 * C2 stopped the emitter writing the opening beat's pictures into the file
 * twice: the pre-rendered markup keeps the payload it needs in order to paint
 * before JavaScript, and the media table borrows it back through a
 * `data-pp-m` marker. A test that wants the artifact's model therefore has to
 * resolve those references the way the artifact does.
 *
 * It resolves them with `ppReadMediaTable` itself — the real function, the one
 * `artifactRuntimeSource` serializes into the file — rather than a second
 * implementation of the same rule. A test that re-implements what it is testing
 * proves the two copies agree and nothing else.
 *
 * The stub below is not a DOM. It answers exactly one query shape,
 * `[data-pp-m="<n>"]`, and hands back an object that can read literal
 * attributes off the tag it found. That is the whole of what the reader uses;
 * the real thing is exercised in a real Chromium by `scripts/verify-offline.mjs`.
 */

import { ppReadMediaTable, ppRehydrateMedia, ppBase64ToBytes, ppInflateRaw, ppUtf8Decode } from '../../../src/emit/artifact-runtime.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** @param {string} value @returns {string} */
function unescapeAttr(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ENTITIES[name]);
}

/**
 * A document that can find `[data-pp-m="<n>"]` and read attributes off it.
 * @param {string} html
 */
export function stubDocument(html) {
  const source = String(html);
  return {
    querySelector(selector) {
      const wanted = /^\[data-pp-m="(\d+)"\]$/.exec(selector);
      if (!wanted) throw new Error(`stubDocument: unsupported selector ${selector}`);
      const tag = new RegExp(`<[a-zA-Z][a-zA-Z0-9-]*\\s[^>]*data-pp-m="${wanted[1]}"[^>]*>`).exec(source);
      if (!tag) return null;
      const open = tag[0];
      return {
        getAttribute(name) {
          const hit = new RegExp(`\\s${name}="([^"]*)"`).exec(open);
          return hit ? unescapeAttr(hit[1]) : null;
        },
      };
    },
  };
}

/**
 * The media table an emitted artifact reassembles at boot, from its own bytes.
 * @param {string} html   the emitted document
 * @returns {string[]}
 */
export function artifactMediaTable(html) {
  const open = '<script id="pp-media" type="application/octet-stream">';
  const start = String(html).indexOf(open);
  if (start < 0) throw new Error('artifactMediaTable: no media element in this document');
  const from = start + open.length;
  const text = String(html).slice(from, String(html).indexOf('</script>', from));
  return ppReadMediaTable(text, stubDocument(html));
}

/**
 * The model an emitted artifact reassembles from its own bytes — decoded,
 * inflated and rehydrated exactly as `ppBootArtifact` does it.
 *
 * An assertion about "what the file carries" has to come from the file.
 * @param {string} html
 * @returns {any}
 */
export function artifactModel(html) {
  const open = '<script id="pp-model" type="application/octet-stream">';
  const start = String(html).indexOf(open);
  if (start < 0) throw new Error('artifactModel: no model element in this document');
  const from = start + open.length;
  const payload = String(html).slice(from, String(html).indexOf('</script>', from));
  const mode = /ppBootArtifact\(\{[^}]*mode: "(\w+)"/.exec(String(html));
  if (!mode) throw new Error('artifactModel: the boot call does not name a compression mode');
  const bytes = ppBase64ToBytes(payload);
  const raw = mode[1] === 'deflate' ? ppInflateRaw(bytes) : bytes;
  return ppRehydrateMedia(JSON.parse(ppUtf8Decode(raw)), artifactMediaTable(html));
}

/**
 * Writing direction, as something a layout renders rather than something a
 * table describes (CRITIQUE-2 C8).
 *
 * §9.1 asks `locale-fanout` for *"locale-appropriate structure, not just
 * translated strings"*. L7 produces exactly that: an `ar-SA` rendition arrives
 * with `dir: 'rtl'` on the rendition and on every block derived from the
 * source. Until this module existed nothing under `src/scene/` read either
 * field — `grep -rn "rtl\|direction" src/scene src/runtime src/emit` returned
 * nothing but `flex-direction` — so the Arabic-market rendition rendered left
 * to right and the only surviving trace of the difference was a table row
 * reading "Writing direction · right to left". The deck *describing* the
 * difference in place of *showing* it is the distinction §9.1 draws.
 *
 * **What is honoured, and what is not.** `dir` and `lang` are optional
 * extensions on `ContentBlock` and `Rendition` — §4's frozen shapes carry
 * neither, and the objection to that is filed in `docs/disputes/L8-scenes.md`.
 * This module reads them where they are present and emits nothing where they
 * are not: a block that declares no direction gets no attribute and inherits
 * the document's, exactly as before. Nothing here guesses a direction from the
 * text, because a guess about which way a client's market reads is a claim
 * §18.2 does not let this tool make.
 *
 * **Block over container.** A rendition mixes the source's language with the
 * tool's own structural labels, so no single `lang` is true of the whole of it
 * (L7's D-L7-18 makes the same point from the other side). A block's own value
 * therefore wins over the rendition's, and the rendition's is a fallback for
 * blocks that carry nothing.
 *
 * @module scene/direction
 */

/** The three values HTML's `dir` attribute takes. Anything else is ignored. */
export const DIRECTIONS = ['ltr', 'rtl', 'auto'];

/**
 * A direction/language pair read off a rendition, a specimen, or a block —
 * whichever object a caller has — with every absent or malformed value
 * normalised to `null`.
 *
 * @param {any} source
 * @returns {{dir: 'ltr'|'rtl'|'auto'|null, lang: string|null}}
 */
export function flowOf(source) {
  const dir = source && DIRECTIONS.includes(source.dir) ? source.dir : null;
  const lang = source && typeof source.lang === 'string' && source.lang.trim()
    ? source.lang.trim()
    : null;
  return { dir, lang };
}

/**
 * The first flow of a list that declares one, so a summary lifted out of a
 * rendition's blocks keeps the direction those blocks were written in.
 * @param {any[]} sources
 * @returns {{dir: 'ltr'|'rtl'|'auto'|null, lang: string|null}}
 */
export function firstFlow(sources) {
  const list = Array.isArray(sources) ? sources : [];
  /** @type {'ltr'|'rtl'|'auto'|null} */
  let dir = null;
  /** @type {string|null} */
  let lang = null;
  for (const source of list) {
    const flow = flowOf(source);
    if (!dir && flow.dir) dir = flow.dir;
    if (!lang && flow.lang) lang = flow.lang;
    if (dir && lang) break;
  }
  return { dir, lang };
}

/**
 * The HTML attributes a flow becomes. Absent values produce no key at all, so
 * spreading this into an attribute object adds nothing when nothing was
 * declared and the emitted markup is byte-identical to what it was before.
 * @param {{dir?: string|null, lang?: string|null}} flow
 * @returns {{dir?: string, lang?: string}}
 */
export function flowAttrs(flow) {
  /** @type {{dir?: string, lang?: string}} */
  const out = {};
  if (flow && DIRECTIONS.includes(flow.dir)) out.dir = flow.dir;
  if (flow && typeof flow.lang === 'string' && flow.lang.trim()) out.lang = flow.lang.trim();
  return out;
}

/**
 * Resolve a block's flow against the container it is being rendered inside.
 * @param {any} block
 * @param {{dir?: string|null, lang?: string|null}} [container]
 * @returns {{dir: 'ltr'|'rtl'|'auto'|null, lang: string|null}}
 */
export function resolveFlow(block, container = {}) {
  const own = flowOf(block);
  const outer = flowOf(container);
  return { dir: own.dir || outer.dir, lang: own.lang || outer.lang };
}

/**
 * True when a flow reads right to left. Used by the layouts that need to know
 * rather than merely to pass the fact on — `systemMap`'s arrows are drawn in
 * SVG, which has no bidi engine to inherit from.
 * @param {{dir?: string|null}} flow
 * @returns {boolean}
 */
export function isRtl(flow) {
  return !!flow && flow.dir === 'rtl';
}

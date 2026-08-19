/**
 * Block helpers shared by the eight seed recipe templates.
 *
 * Every template is built from these, and every one of them is a *selection* or
 * a *reshaping* of the specimen. The only text this module originates is
 * structural labelling — the names of facets, the words "Draft" and "Approved",
 * the marker that a slot has no source content — and none of it can carry a
 * numeral, a quotation or a brand.
 *
 * `finish()` is the choke point: every rendition the library produces goes
 * through it, and it runs the §18.2 guard before `buildRendition` sees the
 * blocks. A template that grows a fabricated fact throws at construction.
 *
 * @module recipe/blocks
 */

import { blockText } from '../core/contracts.js';
import { flatten } from './text.js';
import { buildRendition, DIRECTIONS } from './provenance.js';
import { enforceNoFabricatedFacts } from './facts.js';

/**
 * The marker a template renders where the source has nothing to show. Saying
 * "no source content" out loud is the honest alternative to inventing a
 * plausible German street address (§18.2, §18.3).
 * @param {string} label
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
export function slot(label) {
  return { type: 'paragraph', text: `[${label} — no source content; supply before use]` };
}

/**
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @param {import('../core/contracts.d.ts').ContentBlock['type']} type
 * @returns {import('../core/contracts.d.ts').ContentBlock[]}
 */
export function blocksOfType(specimen, type) {
  return (specimen.blocks || []).filter((b) => b && b.type === type);
}

/**
 * The line a page leads with: its first heading, or its title.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {string}
 */
export function leadHeadline(specimen) {
  const headings = blocksOfType(specimen, 'heading');
  const first = headings.find((h) => flatten(h.text));
  if (first) return flatten(first.text);
  return flatten(specimen.title || '');
}

/**
 * The first paragraph with real text.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {string}
 */
export function leadParagraph(specimen) {
  const p = blocksOfType(specimen, 'paragraph').find((b) => flatten(b.text));
  return p ? flatten(p.text) : '';
}

/**
 * The specimen's primary call to action, if it has one.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {import('../core/contracts.d.ts').ContentBlock|null}
 */
export function leadCta(specimen) {
  const cta = blocksOfType(specimen, 'cta').find((b) => flatten(b.label));
  return cta || null;
}

/** Words that mark a paragraph as the page's legal or policy line. */
const LEGAL_MARKERS = /(©|\(c\)\s*\d|all rights reserved|terms of (use|service)|privacy (policy|notice)|imprint|impressum|legal notice|cookie)/i;

/**
 * The specimen's legal line, with its index, or `null`.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {{block: import('../core/contracts.d.ts').ContentBlock, index: number}|null}
 */
export function legalLine(specimen) {
  const blocks = specimen.blocks || [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b) continue;
    if (b.type !== 'paragraph' && b.type !== 'list') continue;
    const text = blockText(b).join(' ');
    if (LEGAL_MARKERS.test(text)) return { block: b, index: i };
  }
  return null;
}

/**
 * The specimen's body: every block that is not chrome-shaped, in source order.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {import('../core/contracts.d.ts').ContentBlock[]}
 */
export function bodyBlocks(specimen) {
  const legal = legalLine(specimen);
  return (specimen.blocks || []).filter((b, i) => b && (!legal || i !== legal.index));
}

/**
 * The `MediaRef`s a block list actually references, in first-use order.
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {import('../core/contracts.d.ts').MediaRef[]}
 */
export function mediaFor(blocks, specimen) {
  const byId = new Map((specimen.media || []).map((m) => [m.id, m]));
  /** @type {import('../core/contracts.d.ts').MediaRef[]} */
  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    if (!b || b.type !== 'media') continue;
    const ref = byId.get(b.ref);
    if (ref && !seen.has(ref.id)) { seen.add(ref.id); out.push(ref); }
  }
  return out;
}

/**
 * The language the tool's own structural labels are written in.
 *
 * `slot()`, `sectionHeading()` and the format-contract table are the studio's
 * words, not the prospect's, and they are English whatever market a rendition
 * is built for. Marking them `en` is a statement of fact about those strings;
 * marking them with the market's tag would be the claim `locale-fanout`
 * specifically must not make (§18.2, D-L7-18).
 */
export const TOOL_LANG = 'en';

/**
 * Copy the optional direction extensions from an explicit claim onto a block.
 *
 * This is the **narrow** helper, and it is deliberately a whitelist: `from` here
 * is not the block being rebuilt, it is a caller *asserting* a direction and a
 * language, so the two values are validated before they are written. It is the
 * only place in this module that names `dir` and `lang`, and the only place that
 * should.
 *
 * A rebuild — `cloneBlock`, `mapBlockText`, and every other transform that
 * reconstructs a block — must use `carryFields` instead. See its comment for why
 * the direction of the default is the whole point.
 *
 * @template {object} T
 * @param {any} from
 * @param {T} onto
 * @returns {T}
 */
export function carryDirection(from, onto) {
  if (from && DIRECTIONS.includes(from.dir)) /** @type {any} */(onto).dir = from.dir;
  if (from && typeof from.lang === 'string' && from.lang) /** @type {any} */(onto).lang = from.lang;
  return onto;
}

/**
 * Copy a JSON-shaped value, so a carried field never aliases its source.
 *
 * §4's blocks are JSON — they are hashed into a rendition id and serialised into
 * the artifact — so arrays and plain objects are the only containers a block
 * field can hold, and both are copied through. Anything else is a value.
 *
 * @param {any} value
 * @returns {any}
 */
function copyValue(value) {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      /** @type {Record<string, any>} */
      const out = {};
      for (const key of Object.keys(value)) out[key] = copyValue(value[key]);
      return out;
    }
  }
  return value;
}

/**
 * Carry every field of a block forward onto its rebuilt form, except the ones
 * the transform has already dealt with.
 *
 * **This is the class fix for C8's second half, and the direction of the default
 * is the entire point.** A rebuild that lists the fields it carries loses every
 * field added after it was written, and §4's contracts are explicitly designed
 * to grow by optional extension (`API.md` Part 3b). That failure mode has now
 * been found three times in this one module — `dir`, then `lang`, then `pre` —
 * and each time the fix was to add a name to a whitelist, which is a fix for the
 * instance and not for the class. Carrying by default ends the sequence: the
 * fourth extension arrives here already handled, and nobody has to remember.
 *
 * The reason a whitelist was attractive is real: a transform that spreads
 * blindly can carry a field that is no longer *true* of its result. So the
 * exceptions are explicit, per transform, and short — `except` holds:
 *
 * 1. **The fields the transform recomputed.** They are already on `onto`, or the
 *    transform deliberately omitted them (`mapBlockText` drops an empty
 *    `attribution` rather than mapping `''`), and in neither case may the source
 *    value be resurrected underneath the transform's decision.
 * 2. **The fields the transform falsifies** — a value derived from the specific
 *    characters of the text, which a text map makes stale: a cached width, a
 *    measured line count, a hash of the old string.
 *
 * Category 2 is empty today, and that is a claim about §4 and Part 3b rather
 * than an omission. Every field either contract declares is a *structural* fact
 * about the block — `level`, `ordered`, `header`, `href`, `ref`, `dir`, `lang`,
 * `pre` — and a structural fact survives having its text rewritten. A right-to-
 * left paragraph is still right-to-left when it is shortened; a preformatted
 * code sample is still preformatted when it is localised. The day a lane adds a
 * derived field, it belongs in the calling transform's `except` list, next to
 * the fields that transform already owns, and the rule for spotting it is the
 * sentence above: *is this value computed from the text I am about to replace?*
 *
 * Carrying is also a *copy*, not a reference. `cloneBlock` exists so a rendition
 * never shares a mutable object with the specimen it came from, and an unknown
 * extension holding an array would reintroduce exactly that bug if it were
 * carried by reference. `copyValue` is why `cloneBlock` no longer names
 * `items` or `rows`.
 *
 * @template {object} T
 * @param {any} from   the block being rebuilt
 * @param {T} onto     the partially rebuilt result
 * @param {readonly string[]} [except] fields this transform owns or falsifies
 * @returns {T}
 */
export function carryFields(from, onto, except = []) {
  if (!from || typeof from !== 'object') return onto;
  for (const key of Object.keys(from)) {
    if (key in onto) continue;
    if (except.includes(key)) continue;
    /** @type {any} */(onto)[key] = copyValue(from[key]);
  }
  return onto;
}

/**
 * The text-bearing fields of each block type: the ones `mapBlockText` rewrites,
 * and therefore the ones it owns and `carryFields` must not restore behind it.
 *
 * `raw` maps nothing. Its `html` is captured source, and a text transform aimed
 * at prose would corrupt markup; it is carried verbatim like any other field.
 *
 * @type {Record<string, readonly string[]>}
 */
const TEXT_FIELDS = {
  heading: ['text'],
  paragraph: ['text'],
  list: ['items'],
  quote: ['text', 'attribution'],
  table: ['rows'],
  cta: ['label'],
  media: ['caption'],
  raw: [],
};

/**
 * Return a copy of a block carrying an explicit writing direction and, when one
 * is known to be true of its text, a language tag.
 *
 * This is the C8 fix. A rendition this lane *produced* is not captured source,
 * so it must not be handed to a layout as a `raw` block: a `heading` stays a
 * `heading`, a `paragraph` stays a `paragraph`, and the structural facts §4's
 * `ContentBlock` cannot express ride on the optional `dir`/`lang` extensions
 * instead of being smuggled through escaped HTML that the layout then flattens
 * back to plain text under a caption reading "Source markup, shown as text".
 *
 * `lang` is omitted rather than guessed. A rendition whose specimen declares no
 * language gets direction only — saying nothing is honest, and naming the
 * market's language over untranslated copy would not be (D-L7-18).
 *
 * @template {import('../core/contracts.d.ts').ContentBlock} T
 * @param {T} block
 * @param {{dir?: 'ltr'|'rtl'|'auto'|null, lang?: string|null}} attrs
 * @returns {T}
 */
export function withDirection(block, attrs = {}) {
  const out = /** @type {any} */(cloneBlock(block));
  carryDirection(attrs, out);
  if (attrs.lang === null) delete out.lang;
  return out;
}

/**
 * Clone a block, so no rendition ever shares a mutable object with the specimen
 * it was derived from.
 *
 * It names no field but `type`, and it drops nothing: a copy of a block is the
 * same block, so there is nothing a clone can falsify. Every optional extension
 * — declared, or added next week — comes across, deeply.
 *
 * @template {import('../core/contracts.d.ts').ContentBlock} T
 * @param {T} block
 * @returns {T}
 */
export function cloneBlock(block) {
  return /** @type {any} */(carryFields(block, { type: block.type }));
}

/**
 * Apply a text transform to every text run of a block, preserving its type —
 * and preserving everything else about it that is still true, which is all of
 * it (`carryFields`).
 *
 * @param {import('../core/contracts.d.ts').ContentBlock} block
 * @param {(s: string) => string} fn
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
export function mapBlockText(block, fn) {
  const owned = TEXT_FIELDS[block.type];
  if (!owned) return cloneBlock(block);
  /** @type {any} */
  let out;
  switch (block.type) {
    case 'heading': out = { type: 'heading', level: block.level, text: fn(block.text) }; break;
    case 'paragraph': out = { type: 'paragraph', text: fn(block.text) }; break;
    case 'list': out = { type: 'list', ordered: block.ordered, items: block.items.map(fn) }; break;
    case 'quote': out = block.attribution
      ? { type: 'quote', text: fn(block.text), attribution: fn(block.attribution) }
      : { type: 'quote', text: fn(block.text) }; break;
    case 'table': out = { type: 'table', header: block.header, rows: block.rows.map((r) => r.map(fn)) }; break;
    case 'cta': out = { type: 'cta', label: fn(block.label), href: block.href }; break;
    case 'media': out = block.caption
      ? { type: 'media', ref: block.ref, caption: fn(block.caption) }
      : { type: 'media', ref: block.ref }; break;
    case 'raw': out = { type: 'raw' }; break;
    default: return cloneBlock(block);
  }
  return carryFields(block, out, owned);
}

/**
 * A section heading a template adds to organise a rendition. Structural text
 * only: never a claim, never a numeral.
 * @param {string} text
 * @param {1|2|3|4|5|6} [level]
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
export function sectionHeading(text, level = 3) {
  return { type: 'heading', level, text: flatten(text) };
}

/**
 * Build the rendition, with the §18.2 guard between the template and the model.
 *
 * @param {object} args
 * @param {import('../core/contracts.d.ts').Specimen} args.specimen
 * @param {import('../core/contracts.d.ts').Recipe} args.recipe
 * @param {string} args.label
 * @param {import('../core/contracts.d.ts').ContentBlock[]} args.blocks
 * @param {string[]} [args.structural]  bare integers the template legitimately emitted
 * @param {string[]} [args.extraSource] additional legitimate source strings (a brief)
 * @param {string|null} [args.notes]
 * @param {'ltr'|'rtl'} [args.dir]   the rendition's writing direction, when the recipe set one
 * @param {string} [args.lang]       the rendition's predominant language, when one is true of it
 * @returns {import('../core/contracts.d.ts').Rendition}
 */
export function finish({ specimen, recipe, label, blocks, structural = [], extraSource = [], notes = null, dir, lang }) {
  enforceNoFabricatedFacts(blocks, specimen, { structural, extraSource, label: `${recipe.id} / ${label}` });
  return buildRendition({
    specimen,
    recipe,
    label,
    blocks,
    media: mediaFor(blocks, specimen),
    producedBy: 'template',
    notes,
    dir,
    lang,
  });
}

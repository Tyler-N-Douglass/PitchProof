/**
 * §18.2 as code: **there is no "sample stat" generator. Ever.**
 *
 * The tool may reshape, reorder, reformat and re-label the prospect's own
 * content. It may not introduce a fact. This module is the mechanical statement
 * of that rule: given a candidate `ContentBlock[]` and the `Specimen` it was
 * derived from, it returns every numeral, currency amount, percentage,
 * multiplier, spelled-out statistic, quotation, attribution and third-party
 * brand name in the candidate that is not present in the source.
 *
 * Every seed recipe template runs its own output through `enforceNoFabricatedFacts`
 * before returning it, so a template that grows a fabricated fact fails loudly at
 * construction time rather than quietly in front of a client.
 *
 * ---
 *
 * ### What the guard catches
 *
 * 1. **New numerals.** Any numeric token whose digits are absent from the source.
 *    Reformatting is allowed and detected as such: a token is sourced if its
 *    digit sequence matches a source token's (`1,234.50` → `1.234,50`) or if its
 *    multiset of digit runs matches one (`08/17/2026` → `17.08.2026`). That is
 *    exactly the freedom the `locale-fanout` recipe needs and no more.
 * 2. **New units on old digits.** `12` becoming `12%`, `$12` or `12x` is a
 *    fabricated statistic even though the digits are unchanged, so the symbol
 *    class must match a source token carrying the same digits.
 * 3. **Spelled-out statistics.** `forty percent`, `three times faster`,
 *    `half of customers` when the phrase is not in the source.
 * 4. **Testimonial-shaped strings.** Any `quote` block, and any quoted span of
 *    four or more words inside other text, whose folded form is absent from the
 *    source. Attributions are checked separately, because "— VP of Marketing,
 *    Acme" is the exact shape of the fabrication §18.2 forbids.
 * 5. **Named third-party brands** from a documented, deliberately short list of
 *    names that appear on logo walls. A brand the prospect's own page already
 *    mentions is not a finding; a brand only the tool introduced is.
 *
 * ### What the guard cannot catch
 *
 * - **Qualitative fabrication.** "The market leader in retail media" contains no
 *   numeral, no quotation and no listed brand. Nothing here will see it. The
 *   templates cannot produce such a sentence because they only ever emit source
 *   text plus a fixed structural lexicon, but a human pasting into the manual
 *   surface can, and only a human reviewer will catch it.
 * - **A true number used falsely.** If the source says `12` in a page count and
 *   a rendition says `12%` conversion lift, rule 2 fires; but if the source also
 *   happens to contain `12%` elsewhere, the guard sees a sourced token and stays
 *   silent. Provenance in the same context is not checked, because the block
 *   model carries no context to check it against.
 * - **Brands outside the list.** The list is a tripwire, not an ontology. It is
 *   short on purpose: a long list produces false positives on the prospect's own
 *   partners and trains users to ignore the warning.
 * - **Media.** A fabricated logo arriving as an image is invisible here; the
 *   guard reads text. `MediaRef.alt` is folded into the source bag but the pixels
 *   are not inspected.
 * - **Numbers assembled across blocks.** A rendition that puts `3` in one block
 *   and `x` in the next reads as two sourced tokens.
 *
 * ### The structural allowance
 *
 * Some numerals in a rendition describe the artifact itself rather than the
 * client: the three §4 breakpoint widths, the count of tiles in the volume view,
 * the character counts in a channel budget report. Those are declared by the
 * caller in `options.structural` and are permitted — but the allowance is
 * deliberately too narrow to launder a statistic through: an entry must be a
 * bare non-negative integer, optionally suffixed `px`. `42%`, `$1,200` and
 * `3.4x` are rejected by `enforceNoFabricatedFacts` with a thrown error, so the
 * escape hatch cannot carry a unit, a currency or a rate.
 *
 * @module recipe/facts
 */

import { blockText } from '../core/contracts.js';
import {
  numericTokens, groupKey, quotedSpans, foldForCompare, flatten,
  NUMBER_WORDS,
} from './text.js';

/**
 * Third-party names that show up on fabricated logo walls and in fabricated
 * customer lists. Short and documented rather than exhaustive — see the module
 * header for why.
 */
export const WATCHED_BRANDS = [
  'Acme', 'Coca-Cola', 'Nike', 'Adidas', 'Amazon', 'Apple', 'Google', 'Microsoft',
  'Meta', 'Netflix', 'Spotify', 'Salesforce', 'Adobe', 'IBM', 'Oracle', 'SAP',
  'Unilever', 'Nestlé', 'Nestle', 'PepsiCo', 'Samsung', 'Toyota', 'BMW', 'Tesla',
  'Walmart', 'Target', 'Starbucks', 'McDonald', 'Disney', 'Airbnb', 'Uber',
];

/** Compiled once: a word-boundary matcher per watched brand, over folded text. */
const BRAND_MATCHERS = WATCHED_BRANDS.map((brand) => {
  const folded = foldForCompare(brand);
  return {
    brand,
    re: new RegExp(`(^|[^\\p{L}\\p{N}])${folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'iu'),
  };
}).filter((m) => m.re.source.length > 0);

/** Minimum word count for a quoted span to read as a testimonial. */
export const TESTIMONIAL_MIN_WORDS = 4;

/** A structural allowance entry must be a bare integer, optionally `px`. */
const STRUCTURAL_RE = /^\d+(px)?$/;

/**
 * @typedef {object} FactViolation
 * @property {'numeral'|'unit'|'spelled-number'|'testimonial'|'attribution'|'named-entity'} kind
 * @property {string} value        the offending text, verbatim
 * @property {number} blockIndex   index into the candidate block list
 * @property {string} where        block type and, for lists/tables, the cell
 * @property {string} message      one line, safe to show a user
 */

/**
 * @typedef {object} SourceBag
 * @property {Set<string>} digits      digit sequences seen in the source
 * @property {Set<string>} groups      order-insensitive digit-run keys
 * @property {Set<string>} classed     `${kind}:${digits}` and `${kind}:${groupKey}`
 * @property {string} folded           the whole source, folded for comparison
 * @property {Set<string>} tokens      folded word tokens
 */

/**
 * Every string the specimen legitimately contains: block text, metadata values,
 * the title, media alt text, and media intrinsic dimensions.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {string[]}
 */
export function sourceStrings(specimen) {
  /** @type {string[]} */
  const out = [];
  if (!specimen) return out;
  if (typeof specimen.title === 'string') out.push(specimen.title);
  for (const b of specimen.blocks || []) {
    for (const t of blockText(b)) out.push(t);
    if (b && b.type === 'cta' && typeof b.href === 'string') out.push(b.href);
    if (b && b.type === 'media' && typeof b.ref === 'string') out.push(b.ref);
  }
  for (const [k, v] of Object.entries(specimen.meta || {})) { out.push(k); out.push(String(v)); }
  for (const m of specimen.media || []) {
    if (typeof m.alt === 'string') out.push(m.alt);
    if (m.intrinsic) { out.push(String(m.intrinsic.w)); out.push(String(m.intrinsic.h)); }
  }
  if (typeof specimen.locale === 'string' && specimen.locale) out.push(specimen.locale);
  return out;
}

/**
 * Index the source once so a template can be checked cheaply.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @param {string[]} [extra] additional legitimate source strings (a brief, say)
 * @returns {SourceBag}
 */
export function buildSourceBag(specimen, extra = []) {
  const strings = sourceStrings(specimen).concat(extra.map((s) => String(s)));
  const digits = new Set();
  const groups = new Set();
  const classed = new Set();
  for (const s of strings) {
    for (const t of numericTokens(s)) {
      digits.add(t.digits);
      const gk = groupKey(t.groups);
      groups.add(gk);
      classed.add(`${t.kind}:${t.digits}`);
      classed.add(`${t.kind}:g:${gk}`);
    }
  }
  const folded = strings.map(foldForCompare).join('  ');
  const tokens = new Set(folded.split(/[\s]+/).filter(Boolean));
  return { digits, groups, classed, folded, tokens };
}

/**
 * True when a numeric token is a reformatting of something the source said.
 * @param {import('./text.js').NumericToken} tok
 * @param {SourceBag} bag
 * @returns {boolean}
 */
function numericIsSourced(tok, bag) {
  const gk = groupKey(tok.groups);
  const digitsKnown = bag.digits.has(tok.digits) || bag.groups.has(gk);
  if (!digitsKnown) return false;
  if (tok.kind === 'plain') return true;              // dropping a unit invents nothing
  return bag.classed.has(`${tok.kind}:${tok.digits}`) || bag.classed.has(`${tok.kind}:g:${gk}`);
}

const SPELLED_RE = new RegExp(
  `\\b(${NUMBER_WORDS.join('|')})(?:[- ](?:${NUMBER_WORDS.join('|')}))*\\s+(percent|per cent|percentage points?|times|x|fold)\\b`,
  'gi',
);

/**
 * The text runs of a block, paired with a human-readable locus.
 * @param {import('../core/contracts.d.ts').ContentBlock} block
 * @returns {{text: string, where: string}[]}
 */
function runsOf(block) {
  /** @type {{text: string, where: string}[]} */
  const out = [];
  switch (block.type) {
    case 'heading': out.push({ text: block.text, where: `heading h${block.level}` }); break;
    case 'paragraph': out.push({ text: block.text, where: 'paragraph' }); break;
    case 'list': block.items.forEach((it, i) => out.push({ text: it, where: `list item ${i}` })); break;
    case 'quote':
      out.push({ text: block.text, where: 'quote' });
      if (block.attribution) out.push({ text: block.attribution, where: 'quote attribution' });
      break;
    case 'table':
      block.rows.forEach((row, r) => row.forEach((cell, c) => out.push({ text: cell, where: `table r${r}c${c}` })));
      break;
    case 'cta':
      out.push({ text: block.label, where: 'cta label' });
      if (typeof block.href === 'string') out.push({ text: block.href, where: 'cta href' });
      break;
    case 'media': if (block.caption) out.push({ text: block.caption, where: 'media caption' }); break;
    case 'raw': out.push({ text: String(block.html).replace(/<[^>]*>/g, ' '), where: 'raw' }); break;
    default: break;
  }
  return out;
}

/**
 * The §18.2 guard.
 *
 * Returns an array of violations; **empty means clean**, matching the house
 * style of `validateProofShape`. It never throws for content reasons — only for
 * a malformed structural allowance, which is a caller bug.
 *
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks candidate blocks
 * @param {import('../core/contracts.d.ts').Specimen} specimen the source
 * @param {{structural?: string[], extraSource?: string[], bag?: SourceBag}} [options]
 * @returns {FactViolation[]}
 */
export function assertNoFabricatedFacts(blocks, specimen, options = {}) {
  const structural = new Set((options.structural || []).map((s) => String(s)));
  for (const s of structural) {
    if (!STRUCTURAL_RE.test(s)) {
      throw new Error(
        `assertNoFabricatedFacts: structural allowance "${s}" is not a bare integer; `
        + 'a percentage, currency amount or rate can never be declared structural (§18.2)',
      );
    }
  }
  const bag = options.bag || buildSourceBag(specimen, options.extraSource || []);
  /** @type {FactViolation[]} */
  const out = [];

  blocks.forEach((block, blockIndex) => {
    if (!block || typeof block.type !== 'string') return;

    for (const { text, where } of runsOf(block)) {
      const raw = String(text == null ? '' : text);

      // 1 + 2 — numerals and units.
      for (const tok of numericTokens(raw)) {
        if (numericIsSourced(tok, bag)) continue;
        const bare = tok.kind === 'plain' && structural.has(tok.digits);
        const px = tok.kind === 'plain' && structural.has(`${tok.digits}px`)
          && /^\s*px/.test(raw.slice(tok.end));
        if (bare || px) continue;
        out.push({
          kind: tok.kind === 'plain' ? 'numeral' : 'unit',
          value: tok.text,
          blockIndex,
          where,
          message: tok.kind === 'plain'
            ? `numeral "${tok.text}" does not appear in the source specimen`
            : `"${tok.text}" applies a ${tok.kind} that the source does not carry on those digits`,
        });
      }

      // 3 — spelled-out statistics.
      SPELLED_RE.lastIndex = 0;
      let sm;
      while ((sm = SPELLED_RE.exec(raw)) !== null) {
        const phrase = foldForCompare(sm[0]);
        if (bag.folded.includes(phrase)) continue;
        out.push({
          kind: 'spelled-number',
          value: sm[0],
          blockIndex,
          where,
          message: `spelled-out statistic "${sm[0]}" does not appear in the source specimen`,
        });
      }

      // 5 — named third parties.
      const foldedRun = foldForCompare(raw);
      for (const { brand, re } of BRAND_MATCHERS) {
        if (!re.test(foldedRun)) continue;
        if (re.test(bag.folded)) continue;
        out.push({
          kind: 'named-entity',
          value: brand,
          blockIndex,
          where,
          message: `third-party name "${brand}" was introduced by the tool and is not in the source specimen (§18.2)`,
        });
      }
    }

    // 4 — testimonials.
    if (block.type === 'quote') {
      const folded = foldForCompare(block.text);
      if (folded && !bag.folded.includes(folded)) {
        out.push({
          kind: 'testimonial',
          value: flatten(block.text),
          blockIndex,
          where: 'quote',
          message: 'quotation does not appear in the source specimen; the tool may not author a testimonial (§18.2)',
        });
      }
      if (block.attribution) {
        const fa = foldForCompare(block.attribution);
        if (fa && !bag.folded.includes(fa)) {
          out.push({
            kind: 'attribution',
            value: flatten(block.attribution),
            blockIndex,
            where: 'quote attribution',
            message: 'attribution does not appear in the source specimen; the tool may not name a customer (§18.2)',
          });
        }
      }
    }
    for (const { text, where } of runsOf(block)) {
      if (block.type === 'quote' && where === 'quote') continue;
      for (const span of quotedSpans(String(text == null ? '' : text))) {
        if (span.text.split(/\s+/).length < TESTIMONIAL_MIN_WORDS) continue;
        const folded = foldForCompare(span.text);
        if (!folded || bag.folded.includes(folded)) continue;
        out.push({
          kind: 'testimonial',
          value: span.text,
          blockIndex,
          where,
          message: 'quoted passage does not appear in the source specimen (§18.2)',
        });
      }
    }
  });

  return out;
}

/**
 * The throwing form, used by every seed recipe template. A template that would
 * emit a fabricated fact is a defect in this repository, not a runtime
 * condition, so it fails at construction.
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @param {{structural?: string[], extraSource?: string[], bag?: SourceBag, label?: string}} [options]
 * @returns {import('../core/contracts.d.ts').ContentBlock[]} the same blocks
 */
export function enforceNoFabricatedFacts(blocks, specimen, options = {}) {
  const violations = assertNoFabricatedFacts(blocks, specimen, options);
  if (violations.length === 0) return blocks;
  const where = options.label ? ` in "${options.label}"` : '';
  const lines = violations.slice(0, 8).map((v) => `  - [${v.kind}] ${v.where}: ${v.message}`);
  throw new Error(
    `§18.2 violation${where}: ${violations.length} fabricated fact(s)\n${lines.join('\n')}`,
  );
}

/**
 * A one-line machine-readable summary of a guard run, for `Rendition.notes`.
 * L11 parses it to raise an informational finding on pasted or adapter content.
 * @param {FactViolation[]} violations
 * @returns {string|null} null when clean
 */
export function unsourcedNote(violations) {
  if (!violations || violations.length === 0) return null;
  const kinds = Array.from(new Set(violations.map((v) => v.kind))).sort();
  return `[[pp-unsourced:1;n=${violations.length};kinds=${kinds.join(',')}]]`;
}

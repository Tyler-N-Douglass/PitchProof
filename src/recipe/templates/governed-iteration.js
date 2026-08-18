/**
 * `governed-iteration` — the same asset iterated five times, with brand and
 * claim rules holding across all five (§9.5).
 *
 * The interesting half is not that five variants exist; it is that a governance
 * lead can check the five against each other and find the claim set unchanged.
 * So each rendition ends with a **rule ledger**: one row per rule, with the
 * status this iteration holds it at, computed rather than asserted.
 *
 * The rules checked, all of them computable from the blocks themselves:
 *
 * 1. **Claim set** — the multiset of numeric tokens is identical in every
 *    iteration. Computed from the blocks, so an iteration that lost or gained a
 *    figure could not report "held".
 * 2. **Destination** — every iteration's call to action points at the same href.
 * 3. **Attribution** — a quotation carried over from the source appears verbatim
 *    and keeps its attribution.
 * 4. **Voice** — the headline is a permutation of the source headline's own
 *    words plus the source's own action label; no word enters from outside.
 *
 * The five headline forms are constructed by rearranging text the specimen
 * already contains: as-is, action-led, question, shortest clause, and
 * headline-with-standfirst. No synonym, no rewrite, no new adjective.
 *
 * @module recipe/templates/governed-iteration
 */

import { finish, leadHeadline, leadParagraph, leadCta, blocksOfType, cloneBlock, sectionHeading, slot } from '../blocks.js';
import { flatten, firstClause, numericTokens, titleCase } from '../text.js';

/** @type {import('../../core/contracts.d.ts').Recipe} */
export const RECIPE = {
  id: 'governed-iteration',
  name: 'Governed iteration',
  intent: 'Five iterations, and every brand and claim rule still holds in the fifth.',
  inputKinds: ['page', 'product', 'campaign', 'article', 'fragment'],
  outputLabels: ['Iteration 1', 'Iteration 2', 'Iteration 3', 'Iteration 4', 'Iteration 5'],
  adapterPrompt:
    'Produce five iterations of the supplied asset. Every iteration must keep the same claims, the same '
    + 'call-to-action destination and the same attributed quotation, and may only use wording present in the '
    + 'source. Do not add a statistic, price, brand, customer name or quotation.',
};

/** The five headline forms, each a rearrangement of the source's own words. */
export const ITERATION_FORMS = [
  { id: 'as-authored', name: 'As authored' },
  { id: 'action-led', name: 'Action-led' },
  { id: 'question', name: 'Question' },
  { id: 'shortest', name: 'Shortest clause' },
  { id: 'with-standfirst', name: 'Headline with standfirst' },
];

/**
 * @param {number} index
 * @param {{headline: string, action: string, lead: string}} parts
 * @returns {string}
 */
function headlineForm(index, parts) {
  const { headline, action, lead } = parts;
  switch (index) {
    case 1: return action ? `${titleCase(action)} — ${headline}` : headline;
    case 2: return headline ? `${headline.replace(/[.?!]$/, '')}?` : headline;
    case 3: return firstClause(headline);
    case 4: return lead ? `${headline} · ${firstClause(lead)}` : headline;
    default: return headline;
  }
}

/**
 * The multiset of numeric tokens in a block list — the claim set a governance
 * rule holds constant.
 * @param {import('../../core/contracts.d.ts').ContentBlock[]} blocks
 * @returns {string[]} sorted
 */
export function claimSet(blocks) {
  /** @type {string[]} */
  const out = [];
  for (const b of blocks) {
    const runs = b.type === 'list' ? b.items
      : b.type === 'table' ? b.rows.flat()
        : b.type === 'heading' || b.type === 'paragraph' || b.type === 'quote' ? [b.text]
          : b.type === 'cta' ? [b.label] : [];
    for (const r of runs) for (const t of numericTokens(r)) out.push(`${t.kind}:${t.digits}`);
  }
  return out.sort();
}

/**
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @param {number} [options.count] how many iterations; defaults to five
 * @returns {import('../../core/contracts.d.ts').Rendition[]}
 */
export function render(specimen, options = {}) {
  const count = Math.max(1, Math.min(ITERATION_FORMS.length, options.count || ITERATION_FORMS.length));
  const headline = leadHeadline(specimen);
  const lead = leadParagraph(specimen);
  const cta = leadCta(specimen);
  const quote = blocksOfType(specimen, 'quote')[0] || null;
  const lists = blocksOfType(specimen, 'list');
  const action = cta ? flatten(cta.label) : '';

  /** @type {import('../../core/contracts.d.ts').Rendition[]} */
  const out = [];
  /** @type {string[]|null} */
  let firstClaims = null;

  for (let i = 0; i < count; i++) {
    const form = ITERATION_FORMS[i];
    /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
    const body = [];
    body.push({ type: 'heading', level: 1, text: headlineForm(i, { headline, action, lead }) });
    if (lead) body.push({ type: 'paragraph', text: lead });
    if (lists.length) body.push(cloneBlock(lists[0]));
    if (quote) body.push(cloneBlock(quote));
    if (cta) body.push(cloneBlock(cta)); else body.push(slot('Call to action'));

    const claims = claimSet(body);
    if (firstClaims === null) firstClaims = claims;
    const claimsHeld = claims.join('|') === firstClaims.join('|');
    const destinationHeld = !cta || body.some((b) => b.type === 'cta' && b.href === cta.href);
    const attributionHeld = !quote || body.some((b) => b.type === 'quote'
      && flatten(b.text) === flatten(quote.text)
      && (b.attribution || '') === (quote.attribution || ''));
    const voiceHeld = wordsAreSourced(body[0].type === 'heading' ? body[0].text : '', `${headline} ${action} ${lead}`);

    /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
    const blocks = body.concat([
      sectionHeading('Rule ledger', 3),
      {
        type: 'table',
        header: true,
        rows: [
          ['Rule', 'Status'],
          ['Claim set unchanged', claimsHeld ? 'held' : 'broken'],
          ['Action destination unchanged', destinationHeld ? 'held' : 'broken'],
          ['Quotation and attribution unchanged', quote ? (attributionHeld ? 'held' : 'broken') : 'no quotation in source'],
          ['Headline uses only source wording', voiceHeld ? 'held' : 'broken'],
        ],
      },
    ]);

    out.push(finish({
      specimen,
      recipe: RECIPE,
      label: `Iteration ${i + 1}`,
      blocks,
      notes: `${form.name}. Rules held: claim set ${claimsHeld ? 'yes' : 'no'}, destination ${destinationHeld ? 'yes' : 'no'}, attribution ${quote ? (attributionHeld ? 'yes' : 'no') : 'n/a'}, voice ${voiceHeld ? 'yes' : 'no'}.`,
    }));
  }
  return out;
}

/**
 * Is every word of a line drawn from the permitted source text?
 * @param {string} line
 * @param {string} source
 * @returns {boolean}
 */
export function wordsAreSourced(line, source) {
  const pool = new Set(String(source).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const words = String(line).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.every((w) => pool.has(w));
}

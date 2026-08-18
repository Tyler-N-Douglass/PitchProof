/**
 * `channel-variants` — one page becomes email, paid social, in-product message
 * and SMS, **with per-channel length budgets enforced and visible** (§9.2).
 *
 * The budgets are the point. Anyone can put four cards on a slide; the claim
 * that survives a marketing operations lead is "and here is the character count
 * against the published limit, for each part, including the two that are over."
 * So every rendition ends with its budget table, and `Rendition.notes` carries a
 * one-line machine-readable summary L11 can raise a finding from.
 *
 * The copy in each variant is drawn from the specimen: its headline, its lead
 * paragraph, its list items, its call to action. Nothing is rewritten into
 * marketing language, because rewriting is where a tool starts inventing.
 *
 * @module recipe/templates/channel-variants
 */

import { enforceBudget, CHANNEL_BUDGETS, SMS_SEGMENTS } from '../budget.js';
import { finish, leadHeadline, leadParagraph, leadCta, blocksOfType, cloneBlock, slot, legalLine, bodyBlocks } from '../blocks.js';
import { flatten, firstClause, splitAtChars } from '../text.js';

/** @type {import('../../core/contracts.d.ts').Recipe} */
export const RECIPE = {
  id: 'channel-variants',
  name: 'Channel variants',
  intent: 'The same message fits four channels only when someone counts the characters — here is the count.',
  inputKinds: ['page', 'article', 'product', 'campaign'],
  outputLabels: ['Email', 'Paid social', 'In-product message', 'SMS'],
  adapterPrompt:
    'Produce the supplied page as an email, a paid-social ad, an in-product message and an SMS. '
    + 'Respect the character budget given for each part. Use only wording present in the source page; '
    + 'do not introduce a statistic, price, brand, customer name or quotation that is not in it.',
};

/**
 * Build the blocks for one channel from the specimen, before budgeting.
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {string} channelId
 * @returns {import('../../core/contracts.d.ts').ContentBlock[]}
 */
function draftFor(specimen, channelId) {
  const headline = leadHeadline(specimen);
  const lead = leadParagraph(specimen);
  const cta = leadCta(specimen);
  const lists = blocksOfType(specimen, 'list');
  /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
  const blocks = [];

  if (channelId === 'email') {
    const legal = legalLine(specimen);
    const body = bodyBlocks(specimen);
    blocks.push({ type: 'heading', level: 1, text: headline || flatten(specimen.title || '') });
    blocks.push({ type: 'paragraph', text: lead || flatten(specimen.title || '') });
    for (const l of lists.slice(0, 1)) blocks.push(cloneBlock(l));
    const rest = body.filter((b) => b.type === 'paragraph' && flatten(b.text) !== lead).slice(0, 2);
    for (const p of rest) blocks.push(cloneBlock(p));
    blocks.push(cta ? cloneBlock(cta) : slot('Email button label'));
    if (legal) blocks.push(cloneBlock(legal.block));
    return blocks;
  }

  if (channelId === 'paid-social') {
    blocks.push({ type: 'heading', level: 2, text: firstClause(headline) || headline });
    blocks.push({ type: 'paragraph', text: lead });
    if (cta) blocks.push(cloneBlock(cta));
    return blocks.filter((b) => b.type !== 'paragraph' || flatten(b.text));
  }

  if (channelId === 'in-product') {
    blocks.push({ type: 'heading', level: 3, text: firstClause(headline) || headline });
    blocks.push({ type: 'paragraph', text: lead });
    if (cta) blocks.push(cloneBlock(cta));
    return blocks.filter((b) => b.type !== 'paragraph' || flatten(b.text));
  }

  // SMS: one message. The lead sentence plus the action, nothing else.
  const message = [firstClause(headline), splitAtChars(lead, 200).kept].filter(Boolean).join(' — ');
  blocks.push({ type: 'paragraph', text: message || headline });
  if (cta && cta.href) blocks.push({ type: 'cta', label: flatten(cta.label), href: cta.href });
  return blocks;
}

/**
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @param {boolean} [options.truncate]  cut over-budget parts on a word boundary and report what was removed
 * @param {string[]} [options.channels] restrict to a subset of channel ids
 * @returns {import('../../core/contracts.d.ts').Rendition[]}
 */
export function render(specimen, options = {}) {
  const wanted = Array.isArray(options.channels) && options.channels.length
    ? CHANNEL_BUDGETS.filter((b) => options.channels.includes(b.id))
    : CHANNEL_BUDGETS;

  return wanted.map((budget) => {
    const draft = draftFor(specimen, budget.id);
    const result = enforceBudget(draft, budget, { truncate: options.truncate === true });

    const overParts = result.parts.filter((p) => p.overBy > 0);
    const notes = [
      `${budget.channel} budget: ${budget.published ? 'published limits' : 'project convention, stated as such'}.`,
      result.over
        ? `Over budget by ${result.overBy} characters across ${overParts.length} part(s): ${overParts.map((p) => `${p.name} +${p.overBy}`).join(', ')}.`
        : 'Every part is within budget.',
      smsNote(result),
      `[[pp-budget:1;channel=${budget.id};over=${result.overBy};parts=${result.parts.map((p) => `${p.role}:${p.chars}/${p.limit}`).join(',')}]]`,
    ].filter(Boolean).join(' ');

    return finish({
      specimen,
      recipe: RECIPE,
      label: budget.channel,
      blocks: result.blocks,
      structural: result.structural,
      notes,
    });
  });
}

/**
 * A one-line explanation when SMS encoding, not copy length, is what bit.
 * @param {{parts: {role: string, encoding?: string, segments?: number}[]}} result
 * @returns {string}
 */
function smsNote(result) {
  const message = result.parts.find((p) => p.role === 'message');
  if (!message || !message.encoding) return '';
  return message.encoding === 'GSM-7'
    ? `Encoded GSM-7 in ${message.segments} segment(s).`
    : `A character outside the GSM 03.38 alphabet forces UCS-2, which drops the single-segment budget from ${SMS_SEGMENTS.gsm7Single} to ${SMS_SEGMENTS.ucs2Single}; this message takes ${message.segments} segment(s).`;
}

/**
 * The budget outcome for a rendition this recipe produced, parsed back out of
 * `notes`. L11 and the studio inspector both read it.
 * @param {import('../../core/contracts.d.ts').Rendition} rendition
 * @returns {{channel: string, over: number, parts: {role: string, chars: number, limit: number}[]}|null}
 */
export function readBudgetNote(rendition) {
  const m = /\[\[pp-budget:1;channel=([a-z-]+);over=(\d+);parts=([^\]]*)\]\]/.exec(String(rendition && rendition.notes) || '');
  if (!m) return null;
  const parts = m[3] ? m[3].split(',').map((p) => {
    const [role, nums] = p.split(':');
    const [chars, limit] = String(nums || '').split('/');
    return { role, chars: Number(chars), limit: Number(limit) };
  }) : [];
  return { channel: m[1], over: Number(m[2]), parts };
}

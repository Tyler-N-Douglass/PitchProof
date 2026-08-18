/**
 * Per-channel length budgets, enforced and visible (§9.2).
 *
 * The `channel-variants` recipe only lands if the budgets are real. A slide that
 * says "and it fits SMS" while showing 400 characters of copy is worse than no
 * slide. Every limit below is either a **published platform or protocol limit**,
 * cited inline, or is explicitly labelled a project convention where no
 * published limit exists. Nothing is invented and quietly presented as a spec.
 *
 * `enforceBudget` never truncates silently. In its default mode it truncates
 * nothing at all and returns a visible report of exactly how far over each part
 * runs; in `truncate` mode it cuts on a word boundary and reports the character
 * count it removed. Both modes return the same `overBy`, measured against the
 * original content.
 *
 * @module recipe/budget
 */

import { blockText } from '../core/contracts.js';
import { flatten, splitAtChars } from './text.js';

/**
 * Mean English word length, 4.7 letters (Brown corpus), plus one space.
 * `maxWords` is a convenience derived from `maxChars` with this divisor; the
 * character count is always the authority.
 */
export const CHARS_PER_WORD = 5.7;

/**
 * The GSM 03.38 7-bit default alphabet (3GPP TS 23.038, §6.2.1). A message
 * containing anything outside it — and outside the escape-coded extension
 * table — is sent as UCS-2, which halves the segment size.
 */
export const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** Characters that cost two septets via the GSM 03.38 extension table. */
export const GSM7_EXTENDED = '^{}\\[~]|€';

/** SMS segment sizes in characters. 3GPP TS 23.038 / TS 23.040. */
export const SMS_SEGMENTS = {
  /** A single GSM-7 message: 160 septets. */
  gsm7Single: 160,
  /** Concatenated GSM-7: 153 septets per part; 7 septets go to the UDH. */
  gsm7Concatenated: 153,
  /** A single UCS-2 message: 70 characters. */
  ucs2Single: 70,
  /** Concatenated UCS-2: 67 characters per part. */
  ucs2Concatenated: 67,
};

/**
 * @param {number} maxChars
 * @returns {number}
 */
function wordsFor(maxChars) {
  return Math.max(1, Math.floor(maxChars / CHARS_PER_WORD));
}

/**
 * @typedef {object} BudgetPart
 * @property {string} role      stable id, used to assign blocks
 * @property {string} name      display name
 * @property {number} maxChars
 * @property {number} maxWords
 * @property {string} source    where the limit comes from, verbatim
 */

/**
 * @typedef {object} ChannelBudget
 * @property {string} id
 * @property {string} channel        display label
 * @property {number} maxChars       the channel's headline limit (the tightest part that carries the message)
 * @property {number} maxWords
 * @property {BudgetPart[]} parts
 * @property {string[]} sources      every citation, for the studio's inspector
 * @property {boolean} published     false when the numbers are a project convention
 */

/** @type {ChannelBudget[]} */
export const CHANNEL_BUDGETS = [
  {
    id: 'email',
    channel: 'Email',
    maxChars: 60,
    maxWords: wordsFor(60),
    published: true,
    parts: [
      {
        role: 'subject',
        name: 'Subject line',
        maxChars: 60,
        maxWords: wordsFor(60),
        source: 'Display truncation, not a protocol limit: Outlook for Windows shows roughly 60 characters, Gmail on desktop roughly 70, Apple Mail on iPhone in portrait roughly 41. 60 is the tightest of the three desktop clients and is used as the budget; the 41-character mobile point is reported alongside it. The hard technical ceiling is 998 octets per header line (RFC 5322 §2.1.1).',
      },
      {
        role: 'preheader',
        name: 'Preheader',
        maxChars: 100,
        maxWords: wordsFor(100),
        source: 'Gmail and Apple Mail show approximately 100 characters of preview text beside the subject in the inbox list.',
      },
      {
        role: 'body',
        name: 'Body',
        maxChars: 2000,
        maxWords: wordsFor(2000),
        source: 'Project convention. There is no protocol limit on body length; Gmail clips a message above 102 KB and shows "View entire message", which 2000 characters of copy is nowhere near. The budget exists to keep an email variant presentable beside the other three channels.',
      },
      {
        role: 'cta',
        name: 'Button label',
        maxChars: 25,
        maxWords: wordsFor(25),
        source: 'Project convention: a button label longer than 25 characters wraps in a 600px email table cell at 16px.',
      },
    ],
    sources: [
      'RFC 5322 §2.1.1 — line length limit of 998 octets',
      'Client subject-line truncation points, Outlook / Gmail / Apple Mail',
    ],
  },
  {
    id: 'paid-social',
    channel: 'Paid social',
    maxChars: 125,
    maxWords: wordsFor(125),
    published: true,
    parts: [
      {
        role: 'primary',
        name: 'Primary text',
        maxChars: 125,
        maxWords: wordsFor(125),
        source: 'Meta Ads Guide: primary text is truncated with "See more" beyond roughly 125 characters. LinkedIn single-image ads truncate introductory text at 150; X allows 280 per post. 125 is the tightest and is used as the cross-platform budget.',
      },
      {
        role: 'headline',
        name: 'Headline',
        maxChars: 40,
        maxWords: wordsFor(40),
        source: 'Meta Ads Guide: headline recommended at 40 characters. LinkedIn single-image ad headline is 70.',
      },
      {
        role: 'description',
        name: 'Link description',
        maxChars: 30,
        maxWords: wordsFor(30),
        source: 'Meta Ads Guide: link description recommended at 30 characters.',
      },
    ],
    sources: [
      'Meta Ads Guide — primary text 125, headline 40, link description 30',
      'LinkedIn Ads specifications — introductory text 150, headline 70',
      'X (Twitter) — 280 characters per post',
    ],
  },
  {
    id: 'in-product',
    channel: 'In-product message',
    maxChars: 140,
    maxWords: wordsFor(140),
    published: false,
    parts: [
      {
        role: 'title',
        name: 'Title',
        maxChars: 45,
        maxWords: wordsFor(45),
        source: 'Project convention — no vendor publishes a cross-product limit. 45 characters is what fits one line of a 320px in-app panel at 16px.',
      },
      {
        role: 'body',
        name: 'Body',
        maxChars: 140,
        maxWords: wordsFor(140),
        source: 'Project convention — three lines of a 320px panel at 14px.',
      },
      {
        role: 'cta',
        name: 'Action',
        maxChars: 25,
        maxWords: wordsFor(25),
        source: 'Project convention — one button, one line, no wrap.',
      },
    ],
    sources: ['Project convention, stated as such: no published cross-vendor in-product message limit exists.'],
  },
  {
    id: 'sms',
    channel: 'SMS',
    maxChars: SMS_SEGMENTS.gsm7Single,
    maxWords: wordsFor(SMS_SEGMENTS.gsm7Single),
    published: true,
    parts: [
      {
        role: 'message',
        name: 'Message',
        maxChars: SMS_SEGMENTS.gsm7Single,
        maxWords: wordsFor(SMS_SEGMENTS.gsm7Single),
        source: '3GPP TS 23.038: 160 septets in one GSM-7 segment, 153 per segment when concatenated (7 septets go to the user-data header). Any character outside the GSM 03.38 alphabet forces UCS-2, at 70 and 67.',
      },
    ],
    sources: [
      '3GPP TS 23.038 — GSM 7-bit default alphabet and its extension table',
      '3GPP TS 23.040 — concatenated short message user-data header',
    ],
  },
];

/** Aliases the studio, the recipe and a user might all reasonably type. */
const LABEL_ALIASES = {
  email: 'email',
  'e-mail': 'email',
  'email variant': 'email',
  newsletter: 'email',
  'paid social': 'paid-social',
  'paid-social': 'paid-social',
  social: 'paid-social',
  'social ad': 'paid-social',
  ad: 'paid-social',
  'in-product message': 'in-product',
  'in product message': 'in-product',
  'in-product': 'in-product',
  'in-app': 'in-product',
  'in-app message': 'in-product',
  product: 'in-product',
  sms: 'sms',
  'text message': 'sms',
  text: 'sms',
};

/**
 * The budget for a channel label, or `null` when the label names no channel.
 * @param {string} label
 * @returns {ChannelBudget|null}
 */
export function channelBudget(label) {
  if (typeof label !== 'string') return null;
  const key = label.trim().toLowerCase().replace(/\s+/g, ' ');
  const id = LABEL_ALIASES[key] || (CHANNEL_BUDGETS.some((b) => b.id === key) ? key : null);
  if (!id) return null;
  return CHANNEL_BUDGETS.find((b) => b.id === id) || null;
}

/**
 * Is every character in the GSM 03.38 alphabet?
 * @param {string} text
 * @returns {boolean}
 */
export function isGsm7(text) {
  for (const ch of String(text)) {
    if (GSM7_BASIC.includes(ch) || GSM7_EXTENDED.includes(ch)) continue;
    return false;
  }
  return true;
}

/**
 * SMS length in septets: extension-table characters cost two.
 * @param {string} text
 * @returns {number}
 */
export function smsUnits(text) {
  let n = 0;
  for (const ch of String(text)) n += GSM7_EXTENDED.includes(ch) ? 2 : 1;
  return n;
}

/**
 * Segment count for an SMS body under 3GPP TS 23.038 / TS 23.040.
 * @param {string} text
 * @returns {{encoding: 'GSM-7'|'UCS-2', units: number, perSegment: number, segments: number}}
 */
export function smsSegments(text) {
  const s = String(text == null ? '' : text);
  const gsm = isGsm7(s);
  const units = gsm ? smsUnits(s) : Array.from(s).length;
  const single = gsm ? SMS_SEGMENTS.gsm7Single : SMS_SEGMENTS.ucs2Single;
  const multi = gsm ? SMS_SEGMENTS.gsm7Concatenated : SMS_SEGMENTS.ucs2Concatenated;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', units, perSegment: segments > 1 ? multi : single, segments };
}

/**
 * Assign blocks to the parts of a budget.
 *
 * The mapping is structural and fixed per channel, so the same blocks always
 * land in the same parts: headings lead, the first paragraph is the secondary
 * line, `cta` blocks are the action, and everything else is body.
 *
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @param {ChannelBudget} budget
 * @returns {Map<string, number[]>} role → block indices
 */
export function assignParts(blocks, budget) {
  /** @type {Map<string, number[]>} */
  const map = new Map();
  for (const p of budget.parts) map.set(p.role, []);
  const roles = budget.parts.map((p) => p.role);
  const has = (r) => map.has(r);
  const put = (r, i) => { if (has(r)) map.get(r).push(i); };

  let headingsSeen = 0;
  let paragraphsSeen = 0;
  blocks.forEach((b, i) => {
    if (!b || typeof b.type !== 'string') return;
    if (b.type === 'cta') { put(has('cta') ? 'cta' : roles[roles.length - 1], i); return; }
    if (b.type === 'heading') {
      headingsSeen += 1;
      if (headingsSeen === 1 && has('subject')) { put('subject', i); return; }
      if (headingsSeen === 1 && has('headline')) { put('headline', i); return; }
      if (headingsSeen === 1 && has('title')) { put('title', i); return; }
      put(has('body') ? 'body' : has('primary') ? 'primary' : roles[0], i);
      return;
    }
    if (b.type === 'paragraph') {
      paragraphsSeen += 1;
      if (paragraphsSeen === 1 && has('preheader')) { put('preheader', i); return; }
      if (has('primary')) { put('primary', i); return; }
      put(has('body') ? 'body' : has('message') ? 'message' : roles[0], i);
      return;
    }
    if (has('body')) { put('body', i); return; }
    if (has('message')) { put('message', i); return; }
    if (has('primary')) { put('primary', i); return; }
    put(roles[roles.length - 1], i);
  });
  return map;
}

/**
 * @typedef {object} BudgetPartReport
 * @property {string} role
 * @property {string} name
 * @property {number} chars       characters in the part, as supplied
 * @property {number} limit
 * @property {number} overBy      0 when within budget
 * @property {number} removed     characters removed (0 unless truncating)
 * @property {number[]} blockIndices
 * @property {string} source
 * @property {'GSM-7'|'UCS-2'} [encoding]
 * @property {number} [segments]
 * @property {number} [units]
 */

/**
 * @typedef {object} BudgetResult
 * @property {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @property {number} overBy                    total characters over, across all parts
 * @property {boolean} over
 * @property {BudgetPartReport[]} parts
 * @property {import('../core/contracts.d.ts').ContentBlock} report   a table block, ready to render
 * @property {string[]} structural              every bare integer the report emitted
 */

/**
 * Measure content against a channel budget and report the result.
 *
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @param {ChannelBudget|string} budget         a budget, or a channel label
 * @param {{truncate?: boolean, includeReport?: boolean}} [options]
 * @returns {BudgetResult}
 */
export function enforceBudget(blocks, budget, options = {}) {
  const b = typeof budget === 'string' ? channelBudget(budget) : budget;
  const list = Array.isArray(blocks) ? blocks : [];
  if (!b) {
    return {
      blocks: list,
      overBy: 0,
      over: false,
      parts: [],
      report: { type: 'table', header: true, rows: [['Part', 'Characters', 'Limit', 'Over by']] },
      structural: [],
    };
  }
  const truncate = options.truncate === true;
  const includeReport = options.includeReport !== false;
  const assignment = assignParts(list, b);
  const out = list.slice();
  /** @type {Set<number>} */
  const dropped = new Set();
  /** @type {BudgetPartReport[]} */
  const parts = [];
  let overBy = 0;

  for (const part of b.parts) {
    const indices = assignment.get(part.role) || [];
    if (indices.length === 0) continue;
    const text = indices.map((i) => flatten(blockText(list[i]).join(' '))).filter(Boolean).join(' ');
    const chars = Array.from(text).length;
    const partOver = Math.max(0, chars - part.maxChars);
    overBy += partOver;

    /** @type {BudgetPartReport} */
    const report = {
      role: part.role,
      name: part.name,
      chars,
      limit: part.maxChars,
      overBy: partOver,
      removed: 0,
      blockIndices: indices.slice(),
      source: part.source,
    };
    if (b.id === 'sms') {
      const seg = smsSegments(text);
      report.encoding = seg.encoding;
      report.segments = seg.segments;
      report.units = seg.units;
    }

    if (truncate && partOver > 0) {
      let budgetLeft = part.maxChars;
      for (const i of indices) {
        const block = out[i];
        const before = flatten(blockText(block).join(' '));
        if (budgetLeft <= 0) {
          report.removed += Array.from(before).length;
          dropped.add(i);
          continue;
        }
        const { kept, removed } = splitAtChars(before, budgetLeft);
        budgetLeft -= Array.from(kept).length + 1;
        if (removed) {
          report.removed += Array.from(removed).length;
          if (kept) out[i] = withText(block, kept); else dropped.add(i);
        }
      }
    }
    parts.push(report);
  }

  const structural = new Set();
  /** @type {string[][]} */
  const rows = [['Part', 'Characters', 'Limit', 'Over by']];
  for (const p of parts) {
    structural.add(String(p.chars));
    structural.add(String(p.limit));
    structural.add(String(p.overBy));
    const cells = [p.name, String(p.chars), String(p.limit), String(p.overBy)];
    if (p.segments !== undefined) {
      structural.add(String(p.segments));
      structural.add(String(p.units));
      cells[1] = `${p.units} (${p.encoding})`;
      cells[3] = p.overBy > 0 ? `${p.overBy} — ${p.segments} segments` : `0 — ${p.segments} segments`;
    }
    if (truncate && p.removed > 0) { structural.add(String(p.removed)); cells[3] = `${p.overBy} (${p.removed} removed)`; }
    rows.push(cells);
  }
  structural.add(String(overBy));

  /** @type {import('../core/contracts.d.ts').ContentBlock} */
  const report = { type: 'table', header: true, rows };
  const kept = out.filter((_, i) => !dropped.has(i));
  const finalBlocks = includeReport ? kept.concat([report]) : kept;

  return {
    blocks: finalBlocks,
    overBy,
    over: overBy > 0,
    parts,
    report,
    structural: Array.from(structural).sort(),
  };
}

/**
 * @param {import('../core/contracts.d.ts').ContentBlock} block
 * @param {string} text
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
function withText(block, text) {
  switch (block.type) {
    case 'heading': return { type: 'heading', level: block.level, text };
    case 'paragraph': return { type: 'paragraph', text };
    case 'cta': return { type: 'cta', label: text, href: block.href };
    case 'quote': return block.attribution ? { type: 'quote', text, attribution: block.attribution } : { type: 'quote', text };
    default: return block;
  }
}

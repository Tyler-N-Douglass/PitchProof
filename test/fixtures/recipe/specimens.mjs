/**
 * Specimen fixtures for the L7 tests.
 *
 * Built by hand rather than captured, so every value a recipe is allowed to
 * reuse is visible in one place. The §18.2 tests depend on knowing exactly which
 * numerals, quotations and names the source contains — `1,800`, `$400`,
 * `08/17/2026`, `nine`, the quotation and its attribution — and nothing else.
 */

import { contentId } from '../../../src/core/ids.js';

const CLOCK = '2026-08-18T09:30:00.000Z';

/**
 * A realistic B2B page: heading hierarchy, prose carrying a date, a price and a
 * grouped number, a feature list, a spec table, a testimonial the prospect
 * published themselves, a media block, a call to action, and a legal line.
 * @param {object} [overrides]
 * @returns {import('../../../src/core/contracts.d.ts').Specimen}
 */
export function retailSpecimen(overrides = {}) {
  /** @type {import('../../../src/core/contracts.d.ts').ContentBlock[]} */
  const blocks = [
    { type: 'heading', level: 1, text: 'Retail media, unified across every market' },
    { type: 'paragraph', text: 'Northwind connects brands and retailers in one plan, launched 08/17/2026 across nine markets.' },
    { type: 'heading', level: 2, text: 'What the platform covers' },
    { type: 'list', ordered: false, items: ['Onsite retail media', 'Offsite audience extension', 'In-store screens', 'Closed-loop reporting'] },
    { type: 'paragraph', text: 'Teams plan, buy and report in one place, with 1,800 campaigns live at any time and seats from $400.' },
    { type: 'table', header: true, rows: [['Plan', 'Seats', 'Price'], ['Team', '10', '$400'], ['Business', '50', '$1,800']] },
    { type: 'quote', text: 'We moved a full quarter of planning into one workspace in a fortnight.', attribution: 'Head of Digital, Northwind' },
    { type: 'media', ref: 'md_hero', caption: 'The unified planning board' },
    { type: 'cta', label: 'Book a demo', href: '/book-a-demo' },
    { type: 'paragraph', text: '© Northwind Retail Group. Terms of service and privacy policy apply.' },
  ];

  /** @type {import('../../../src/core/contracts.d.ts').Specimen} */
  const specimen = {
    id: contentId('specimen', { fixture: 'retail' }),
    kind: 'page',
    title: 'Retail media, unified',
    sourceUrl: 'https://example.invalid/retail-media',
    capturedAt: CLOCK,
    blocks,
    media: [
      { id: 'md_hero', dataUri: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Planning board', intrinsic: { w: 1600, h: 900 }, bytes: 12 },
    ],
    meta: { title: 'Retail media, unified', lang: 'en-US', description: 'One plan for onsite, offsite and in-store.' },
    wordCount: 96,
    locale: 'en-US',
    ...overrides,
  };
  return specimen;
}

/**
 * A minimal specimen: one heading and one paragraph, no media, no legal line,
 * no call to action. Exercises the empty-slot paths.
 * @returns {import('../../../src/core/contracts.d.ts').Specimen}
 */
export function briefSpecimen() {
  return {
    id: contentId('specimen', { fixture: 'brief' }),
    kind: 'fragment',
    title: 'Spring campaign brief',
    sourceUrl: null,
    capturedAt: CLOCK,
    blocks: [
      {
        type: 'paragraph',
        text: 'Announce the unified planning board to existing retail media customers. '
          + 'It brings onsite, offsite and in-store into one plan, and removes the weekly reconciliation step. '
          + 'Book a walkthrough with the account team.',
      },
    ],
    media: [],
    meta: { lang: 'en-GB' },
    wordCount: 42,
    locale: 'en-GB',
  };
}

/**
 * A specimen with **no digits anywhere**. It exists because a source with no
 * numerals is the case that exposes a template quietly relying on the source to
 * legitimise a number it generated itself — which is exactly how the §18.2 guard
 * caught an SMS budget report naming its own encoding.
 * @returns {import('../../../src/core/contracts.d.ts').Specimen}
 */
export function digitFreeSpecimen() {
  return {
    id: contentId('specimen', { fixture: 'digit-free' }),
    kind: 'article',
    title: 'Designing fouling margin you will actually use',
    sourceUrl: 'https://example.invalid/fouling-margin',
    capturedAt: CLOCK,
    blocks: [
      { type: 'heading', level: 1, text: 'Designing fouling margin you will actually use' },
      { type: 'paragraph', text: 'The fouling factor is the most over-specified number on a heat exchanger datasheet.' },
      { type: 'paragraph', text: 'Margin bought at the design stage is margin you pay for in pumping power for the life of the unit.' },
      { type: 'cta', label: 'Have an existing unit assessed', href: '/service/assessment/' },
    ],
    media: [],
    meta: { lang: 'en-GB' },
    wordCount: 40,
    locale: 'en-GB',
  };
}

/** The pasted-output fixtures used by the alignment and paste tests. */
export const PASTED = {
  markdown: [
    '# Retail media, unified across every market',
    '',
    'Northwind connects brands and retailers in one plan, launched 08/17/2026 across nine markets.',
    '',
    '## What the platform covers',
    '',
    '- Onsite retail media',
    '  - Sponsored product',
    '- Offsite audience extension',
    '- In-store screens',
    '',
    '> We moved a full quarter of planning into one workspace in a fortnight. — Head of Digital',
    '',
    '| Plan | Seats | Price |',
    '|---|---|---|',
    '| Team | 10 | $400 |',
    '',
    '[Book a demo](/book-a-demo)',
    '',
    '```',
    'plan --market all',
    '```',
    '',
  ].join('\n'),

  html: '<article><h1>Retail media, unified across every market</h1>'
    + '<p>Northwind connects <strong>brands</strong> &amp; retailers in one plan.<br>Launched across nine markets.</p>'
    + '<ul><li>Onsite retail media<ul><li>Sponsored product</li></ul></li><li>Offsite audience extension</li></ul>'
    + '<blockquote><p>We moved a full quarter of planning into one workspace.</p><cite>Head of Digital</cite></blockquote>'
    + '<table><thead><tr><th>Plan</th><th>Seats</th></tr></thead><tbody><tr><td>Team</td><td>10</td></tr></tbody></table>'
    + '<figure><img src="/hero.png" alt="Planning board"><figcaption>The unified planning board</figcaption></figure>'
    + '<p class="btn"><a href="/book-a-demo">Book a demo</a></p>'
    + '<script>window.track()</script><style>.x{color:red}</style></article>',

  plain: [
    'Retail media, unified',
    '',
    'Northwind connects brands and retailers in one plan. It launched across nine markets.',
    '',
    'What the platform covers',
    '',
    'Onsite, offsite and in-store inventory, planned together and reported once.',
    '',
  ].join('\n'),
};

/**
 * The copy the overflow corpus is built from.
 *
 * Everything here is written for this test suite. It reads like the marketing
 * copy a real specimen would carry — that matters, because the line-breaking
 * behaviour of "Reduce time-to-market across nine regions" is not the behaviour
 * of `lorem ipsum`: real copy has long compounds, hyphenates, numerals, and an
 * uneven word-length distribution, and those are what decide where a line breaks.
 *
 * No prospect, customer or third party is named anywhere in this file (§18.2).
 */

/** Headlines: display-weight copy, the shape that overflows first. */
export const HEADLINES = [
  'Every market launch, on brand, in one afternoon',
  'From a single brief to forty on-brand assets',
  'The approval chain your legal team already trusts',
  'Nine markets. One source of truth. No retyping.',
  'Localisation that reads like it was written there',
  'Stop rebuilding the same page for every channel',
  'Governed iteration, without the governance meeting',
  'Your design system, assembled at three breakpoints',
];

/** Sub-headlines: one long sentence, the shape that wraps to two or three lines. */
export const SUBHEADS = [
  'Take the page your team already publishes, and produce the market variants, the channel cutdowns and the in-product messages from it — with the same brand rules holding across all of them.',
  'The before side of every comparison is your own content, captured from your own site, unmodified. The after side is what the same content looks like once the system does the assembly.',
  'Every asset carries its provenance. Nothing here claims a person approved copy that a person has not approved.',
];

/** Body paragraphs: the shape that overflows on the height axis. */
export const PARAGRAPHS = [
  'A campaign that ships in nine markets today needs nine briefs, nine rounds of layout, nine review threads and nine sets of corrections. The work is not the writing; the work is the retyping, the reformatting and the chasing. That is the part a system can take.',
  'When the brand system is the input rather than a PDF somebody remembers to check, the guardrails come for free. Colour, type, spacing and claim language are enforced at assembly time instead of caught at review time, which is the difference between a correction and a rebuild.',
  'The question is never whether a tool can produce a variant. It is whether the fortieth variant is as on-brand as the first, whether the person who has to sign it off can see what changed, and whether the whole thing survives contact with a market that does not speak the source language.',
  'Approval is not a checkbox. It is a chain of people who each need to see a different thing: the writer needs the copy, the designer needs the layout, legal needs the claim, and the market lead needs the whole page in their own language, at the size it will actually run.',
];

/**
 * German compounds. The classic unbreakable-run failure: a single token wider
 * than its container, with no break opportunity inside it, which no amount of
 * line breaking rescues.
 */
export const GERMAN_COMPOUNDS = [
  'Markteinführungsgeschwindigkeit',
  'Produktinformationsmanagementsystem',
  'Rechtsschutzversicherungsgesellschaft',
  'Kundenzufriedenheitsuntersuchung',
  'Zusammenarbeitsvereinbarungen',
];

/** German sentences carrying those compounds, for the wrapped cases. */
export const GERMAN_SENTENCES = [
  'Die Markteinführungsgeschwindigkeit steigt, weil das Produktinformationsmanagementsystem alle Varianten aus derselben Quelle erzeugt.',
  'Unsere Kundenzufriedenheitsuntersuchung zeigt, dass Zusammenarbeitsvereinbarungen schneller unterzeichnet werden.',
];

/**
 * Japanese and Chinese copy. Every one of these codepoints advances a full em in
 * the Latin fallbacks an artifact can count on, and a run of them breaks between
 * characters rather than at spaces — two behaviours that make CJK overflow in
 * places Latin copy never would.
 */
export const CJK = [
  '製品情報管理システムがすべてのバリエーションを同じソースから生成します',
  '九つの市場向けのキャンペーンを一つのブリーフから作成できます',
  '品牌规范在装配时强制执行而不是在评审时才发现问题',
  'すべての素材には出所が記録されており承認されていない内容を承認済みとは表示しません',
];

/** Short labels: buttons, chips, the provenance label. These must not overflow. */
export const LABELS = [
  'Illustrative — not client-approved content',
  'Before',
  'After — assembled from the design system',
  'Client-supplied',
  'de-DE',
  'Email variant',
  'PDP module',
  'View the approval chain',
];

/** Long single tokens that are not words: URLs, ids, file names. */
export const LONG_TOKENS = [
  'PRODUCT_INFORMATION_MANAGEMENT_SYSTEM_EXPORT_20260218_FINAL_v7',
  'campaignassetsEMEAdeDEproductdetailpageheroimage2400x1200',
];

/**
 * The same shape, but with hyphens and slashes in it. Every one of those is a
 * break opportunity, so this token wraps and must *not* be reported — the
 * negative control for the unbreakable-run cases.
 */
export const BREAKABLE_TOKEN =
  'campaign-assets/emea/de-DE/product-detail-page-hero-2400x1200.png';

/**
 * `dam-round-trip` — asset sourced, variant produced, metadata written back
 * (§9.7).
 *
 * The claim is closure: the loop ends where it started, with the record updated,
 * rather than with a file in someone's downloads folder. Three renditions trace
 * it, and the third is a **field-level diff** — before, after, and who wrote it —
 * so a DAM owner can see exactly which fields the round trip touched.
 *
 * Every "after" value is derived from the specimen: the alt text becomes the
 * source heading, the variant's parent is the source media id, the dimensions
 * are the source's own intrinsic dimensions. Fields the tool cannot know — usage
 * rights, expiry, owning team — are written back as labelled empty slots, never
 * as plausible values. A fabricated rights statement in a DAM is a worse
 * fabrication than a fabricated statistic on a slide.
 *
 * §1.1.3 forbids building a DAM integration, and this does not: it is a
 * pre-baked depiction of the round trip against the prospect's own asset record.
 * Nothing here talks to anything.
 *
 * @module recipe/templates/dam-round-trip
 */

import { finish, leadHeadline, blocksOfType, sectionHeading, slot } from '../blocks.js';
import { flatten, splitAtChars } from '../text.js';

/** @type {import('../../core/contracts.d.ts').Recipe} */
export const RECIPE = {
  id: 'dam-round-trip',
  name: 'DAM round trip',
  intent: 'The loop closes: the asset comes from the record, the variant goes back to it, and the metadata is updated.',
  inputKinds: ['image', 'product', 'campaign', 'page', 'document'],
  outputLabels: ['Sourced asset', 'Variant produced', 'Metadata written back'],
  adapterPrompt:
    'Show the supplied asset as it is held in a DAM record, a derived variant, and the metadata written back '
    + 'to the record. Leave any field you cannot derive from the source explicitly empty; never guess usage '
    + 'rights, ownership or expiry.',
};

/** Metadata fields the round trip touches, in DAM record order. */
const FIELDS = ['Asset id', 'Filename', 'Alt text', 'Dimensions', 'Locale', 'Variant of', 'Usage rights', 'Owning team', 'Review state'];

/**
 * The source media the round trip is about, or `null`.
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @returns {import('../../core/contracts.d.ts').MediaRef|null}
 */
export function primaryMedia(specimen) {
  const media = specimen.media || [];
  if (media.length === 0) return null;
  return media.slice().sort((a, b) => (b.intrinsic.w * b.intrinsic.h) - (a.intrinsic.w * a.intrinsic.h) || a.id.localeCompare(b.id))[0];
}

/**
 * @param {import('../../core/contracts.d.ts').MediaRef|null} media
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @returns {Map<string, string>}
 */
function sourceRecord(media, specimen) {
  /** @type {Map<string, string>} */
  const rec = new Map();
  rec.set('Asset id', media ? media.id : '[no asset in source]');
  rec.set('Filename', media ? (specimen.meta[`media:${media.id}:name`] || media.id) : '[no asset in source]');
  rec.set('Alt text', media && media.alt ? flatten(media.alt) : '[empty in source]');
  rec.set('Dimensions', media ? `${media.intrinsic.w}px wide, ${media.intrinsic.h}px high` : '[unknown]');
  rec.set('Locale', specimen.locale || '[not recorded]');
  rec.set('Variant of', '[original]');
  rec.set('Usage rights', specimen.meta['rights'] || specimen.meta['usage'] || '[not recorded in source]');
  rec.set('Owning team', specimen.meta['owner'] || '[not recorded in source]');
  rec.set('Review state', '[not recorded in source]');
  return rec;
}

/**
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @param {string} [options.variantLabel] the crop or ratio name for the variant
 * @returns {import('../../core/contracts.d.ts').Rendition[]}
 */
export function render(specimen, options = {}) {
  const media = primaryMedia(specimen);
  const headline = leadHeadline(specimen);
  const variantLabel = typeof options.variantLabel === 'string' && options.variantLabel
    ? options.variantLabel
    : 'square social crop';
  const before = sourceRecord(media, specimen);

  const after = new Map(before);
  after.set('Alt text', headline ? splitAtChars(headline, 120).kept : before.get('Alt text'));
  after.set('Variant of', media ? media.id : '[no asset in source]');
  after.set('Review state', 'produced, awaiting approval');
  after.set('Filename', media ? `${before.get('Filename')} — ${variantLabel}` : before.get('Filename'));

  const structural = media ? [String(media.intrinsic.w), String(media.intrinsic.h)] : [];

  /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
  const sourced = [sectionHeading('Sourced from the record', 2)];
  if (media) sourced.push({ type: 'media', ref: media.id, caption: media.alt ? flatten(media.alt) : flatten(headline) });
  else sourced.push(slot('Source asset'));
  sourced.push({
    type: 'table',
    header: true,
    rows: [['Field', 'Value in the record']].concat(FIELDS.map((f) => [f, before.get(f) || '[not recorded in source]'])),
  });

  /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
  const variant = [sectionHeading(`Variant produced — ${variantLabel}`, 2)];
  if (media) variant.push({ type: 'media', ref: media.id, caption: `${flatten(headline)} — ${variantLabel}` });
  else variant.push(slot('Variant'));
  variant.push({
    type: 'list',
    ordered: true,
    items: [
      `Derived from the record's own asset, not re-shot: ${before.get('Asset id')}`,
      `Crop named ${variantLabel}; the source pixels are unchanged`,
      'Alt text carried from the page heading it illustrates',
      'Usage rights are not inferred; the field stays as the record holds it',
    ],
  });

  /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
  const writeback = [sectionHeading('Metadata written back', 2)];
  writeback.push({
    type: 'table',
    header: true,
    rows: [['Field', 'Before', 'After', 'Written by']].concat(
      FIELDS.map((f) => {
        const b = before.get(f) || '[not recorded in source]';
        const a = after.get(f) || b;
        return [f, b, a, a === b ? 'unchanged' : 'variant pipeline'];
      }),
    ),
  });
  const changed = FIELDS.filter((f) => (after.get(f) || '') !== (before.get(f) || ''));
  writeback.push({
    type: 'paragraph',
    text: changed.length
      ? `Fields written back: ${changed.join(', ')}. Every other field is left exactly as the record holds it.`
      : 'No field changed; the record already described this variant.',
  });

  return [
    finish({ specimen, recipe: RECIPE, label: 'Sourced asset', blocks: sourced, structural, notes: 'The asset as the record holds it. Fields the source does not carry are marked empty rather than filled.' }),
    finish({ specimen, recipe: RECIPE, label: 'Variant produced', blocks: variant, structural, notes: `Variant "${variantLabel}" derived from the source asset. No pixels invented, no rights asserted.` }),
    finish({ specimen, recipe: RECIPE, label: 'Metadata written back', blocks: writeback, structural, notes: `Write-back diff. Changed fields: ${changed.length ? changed.join(', ') : 'none'}.` }),
  ];
}

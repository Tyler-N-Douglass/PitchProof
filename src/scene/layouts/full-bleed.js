/**
 * `fullBleed` — one visual filling the frame (§4).
 *
 * Used where a scene has one thing to say and a picture that says it: a hero,
 * a captured page, an asset in situ. There is no header band; the headline
 * lives in an overlay panel on the visual, because a full-bleed scene with a
 * header band above it is not full bleed.
 *
 * Two honesty rules apply harder here than anywhere else:
 *  - a `MediaRef` is rendered only when it is a `data:` URI (§13 — an artifact
 *    that reaches the network for its hero image is a failed artifact), and a
 *    missing asset renders a visible frame saying so rather than a blank screen
 *    the presenter discovers live;
 *  - when the visual comes from an illustrative rendition, the provenance label
 *    sits *in the overlay* — on top of the image, in the client's eyeline, not
 *    tucked into a corner of the layout (§9, §18.1).
 *
 * With no media at all the layout degrades to a typographic statement rather
 * than to an empty box: the headline set large is a legitimate full-bleed
 * scene, and it is what the studio shows while assets are still being gathered.
 *
 * @module scene/layouts/full-bleed
 */

import { h } from '../../core/vdom.js';
import { flowAttrs, flowOf } from '../direction.js';
import {
  provenanceLabel, emptyState, specimenTitle, renditionLabel, withProvenanceLedger,
} from '../parts.js';

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../../core/vdom.js').VNode}
 */
export function fullBleed(ctx) {
  const pick = pickVisual(ctx);
  const scene = ctx.scene;

  // `pickVisual` selects one carrier. Where the specimen supplied the image the
  // selected rendition is null, and where several renditions are attached only
  // the one that carried a usable image is scoped — so the overlay's label
  // covers at most one of them. The ledger carries the rest, pinned to the foot
  // of the frame by `.pp-layout--bleed .pp-provenance-ledger`.
  return withProvenanceLedger(h('div', {
    class: `pp-layout pp-layout--bleed${pick.media ? '' : ' pp-layout--bleed-type'}`,
    'data-pp-layout': 'fullBleed',
    'data-pp-box': 'stage',
  },
  h('figure', {
    class: 'pp-bleed-frame',
    'data-pp-box': 'bleedMedia',
    'data-pp-el': ctx.el('bleed/media'),
    'data-pp-group': 'media',
    'data-pp-rendition': pick.rendition ? pick.rendition.id : null,
  },
  pick.media
    ? h('img', {
      class: 'pp-bleed-img',
      src: pick.media.dataUri,
      alt: pick.media.alt || scene.headline || specimenTitle(ctx.specimen),
      width: pick.media.intrinsic && pick.media.intrinsic.w ? String(pick.media.intrinsic.w) : null,
      height: pick.media.intrinsic && pick.media.intrinsic.h ? String(pick.media.intrinsic.h) : null,
    })
    : h('div', { class: 'pp-bleed-void', role: 'presentation' },
      h('p', { class: 'pp-bleed-void-text', 'data-pp-tx': 'caption' },
        pick.reason))),

  h('div', {
    class: 'pp-bleed-overlay',
    'data-pp-box': 'bleedOverlay',
    'data-pp-el': ctx.el('bleed/overlay'),
    'data-pp-group': 'head',
    'data-pp-rendition': pick.rendition ? pick.rendition.id : null,
  },
  h('div', { class: 'pp-bleed-overlay-inner' },
    pick.source ? h('p', { class: 'pp-bleed-kicker', 'data-pp-tx': 'kicker' }, pick.source) : null,
  scene.headline
    ? h('h2', { class: 'pp-bleed-headline', 'data-pp-tx': 'displayXL', 'data-pp-clamp': '3' }, scene.headline)
    : null,
  scene.subhead
    ? h('p', { class: 'pp-bleed-sub', 'data-pp-tx': 'displaySub', 'data-pp-clamp': '3' }, scene.subhead)
    : null,
  // The caption is the carrier's own words — a media block's caption from the
  // rendition or from the specimen — so it reads in that content's direction,
  // unlike the kicker above it, which is the rendition's *label* (C8).
  pick.caption
    ? h('p', {
      class: 'pp-bleed-caption',
      'data-pp-tx': 'caption',
      'data-pp-clamp': '2',
      ...flowAttrs(flowOf(pick.rendition || ctx.specimen)),
    }, pick.caption)
    : null,
    !scene.headline && !scene.subhead && !pick.caption && !pick.source
      ? emptyState('This scene has no headline yet.')
      : null),
  provenanceLabel(pick.rendition, ctx))), ctx);
}

/**
 * The visual, and where it came from. Renditions win over the specimen when the
 * scene carries one, because a full-bleed scene attached to a rendition is
 * showing the rendition.
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {{media: import('../../core/contracts.d.ts').MediaRef|null, rendition: any, source: string|null, caption: string|null, reason: string}}
 */
export function pickVisual(ctx) {
  const rends = Array.isArray(ctx.renditions) ? ctx.renditions.filter(Boolean) : [];
  for (let i = 0; i < rends.length; i++) {
    const found = firstUsableMedia(rends[i], ctx);
    if (found) {
      return {
        media: found.media,
        rendition: rends[i],
        source: renditionLabel(rends[i], i),
        caption: found.caption,
        reason: '',
      };
    }
  }
  const fromSpecimen = firstUsableMedia(ctx.specimen, ctx);
  if (fromSpecimen) {
    return {
      media: fromSpecimen.media,
      rendition: null,
      source: ctx.specimen ? specimenTitle(ctx.specimen) : null,
      caption: fromSpecimen.caption,
      reason: '',
    };
  }
  const carrier = rends[0] || ctx.specimen || null;
  const hasRefs = carrier && ((Array.isArray(carrier.media) && carrier.media.length > 0)
    || (Array.isArray(carrier.blocks) && carrier.blocks.some((b) => b && b.type === 'media')));
  return {
    media: null,
    rendition: rends[0] || null,
    source: carrier ? (rends[0] ? renditionLabel(rends[0], 0) : specimenTitle(ctx.specimen)) : null,
    caption: null,
    reason: hasRefs
      ? 'This image is not included in this build.'
      : 'No image attached to this scene.',
  };
}

/**
 * The first media a carrier can actually show: a `data:` URI, resolved through
 * the carrier's own media list first and the scene's media map second.
 * @returns {{media: import('../../core/contracts.d.ts').MediaRef, caption: string|null}|null}
 */
function firstUsableMedia(carrier, ctx) {
  if (!carrier) return null;
  const usable = (m) => m && typeof m.dataUri === 'string' && m.dataUri.startsWith('data:');

  const blocks = Array.isArray(carrier.blocks) ? carrier.blocks : [];
  for (const block of blocks) {
    if (!block || block.type !== 'media') continue;
    const direct = (Array.isArray(carrier.media) ? carrier.media : []).find((m) => m && m.id === block.ref);
    const viaMap = ctx.media ? ctx.media.get(String(block.ref)) : null;
    const media = usable(direct) ? direct : (usable(viaMap) ? viaMap : null);
    if (media) return { media, caption: block.caption ? String(block.caption) : (media.alt || null) };
  }
  const own = (Array.isArray(carrier.media) ? carrier.media : []).find(usable);
  return own ? { media: own, caption: own.alt || null } : null;
}

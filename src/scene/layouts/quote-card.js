/**
 * `quoteCard` — a pulled quote with attribution (§4).
 *
 * One sentence, given the room. Used for the client's own words — a line from
 * their brand guidelines, a stakeholder's phrasing of the problem, a passage
 * from the page under discussion — where reading it aloud from a dense slide
 * would waste it.
 *
 * §18.2 is the binding constraint. **This layout never invents a quote and
 * never invents an attribution.** It renders, in order of preference: a `quote`
 * block from a rendition, a `quote` block from the specimen, or the scene's own
 * headline set as a statement with no attribution at all. An attribution
 * appears only when the block carries one; there is no "— a customer" fallback,
 * because that is exactly the fabricated testimonial §18.2 forbids.
 *
 * That preference order is also where §18.1 was being lost. Only the first of
 * the four branches pulls from a rendition, and only that branch rendered a
 * provenance label — so a scene declaring an illustrative rendition whose
 * blocks hold no `quote` (a section cut at a heading boundary, which is what a
 * real page produces) showed the specimen's quote, or its own headline, with
 * the rendition declared and nothing on screen saying it was illustrative. The
 * scene's headline is frequently the rendition's own leading heading, so that
 * was rendition-derived text presented unlabelled. Every branch now ends in
 * `withProvenanceLedger`.
 *
 * @module scene/layouts/quote-card
 */

import { h } from '../../core/vdom.js';
import { flowAttrs, flowOf } from '../direction.js';
import { firstOfType } from '../blocks.js';
import {
  sceneHead, provenanceLabel, emptyState, specimenTitle, renditionLabel, specimenMeta,
  withProvenanceLedger, withEditedNotice,
} from '../parts.js';

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../../core/vdom.js').VNode}
 */
export function quoteCard(ctx) {
  const pulled = pullQuote(ctx);

  // The ledger is what keeps the fallback branches honest. This layout selects
  // one quotation and may take it from the specimen — or, with no quote in the
  // model at all, from the scene's own headline — while the scene still
  // declares the renditions it was built from. Every branch below reaches
  // `withProvenanceLedger`, so a declared illustrative rendition is labelled on
  // all four of them rather than only on the one that pulled from a rendition.
  // …and `withEditedNotice` is the same argument for §18.3. This layout can put
  // one sentence of the client's page on a slide with nothing else around it;
  // where that page was edited, the notice strip is what says so, because there
  // is no panel head here to carry the marker.
  return withEditedNotice(withProvenanceLedger(h('div', {
    class: 'pp-layout pp-layout--quote',
    'data-pp-layout': 'quoteCard',
    'data-pp-box': 'stage',
  },
  pulled.fallback ? null : sceneHead(ctx, { kicker: pulled.kicker }),
  pulled.text
    ? h('figure', {
      class: 'pp-quote-card',
      'data-pp-box': 'quoteBox',
      'data-pp-variant': pulled.fallback ? 'full' : null,
      'data-pp-el': ctx.el('quote/text'),
      'data-pp-group': 'quote',
      'data-pp-rendition': pulled.rendition ? pulled.rendition.id : null,
    },
    h('div', { class: 'pp-quote-rule', 'aria-hidden': 'true' }),
    h('blockquote', { class: 'pp-quote-body' },
      h('p', { class: 'pp-quote-line', 'data-pp-tx': 'quote', 'data-pp-clamp': '8', ...flowAttrs(flowOf(pulled.rendition)) }, pulled.text)),
    pulled.attribution || pulled.source
      ? h('figcaption', {
        class: 'pp-quote-figcaption',
        'data-pp-el': ctx.el('quote/attribution'),
        'data-pp-group': 'attribution',
      },
      pulled.attribution
        ? h('p', { class: 'pp-quote-attribution', 'data-pp-tx': 'attribution', 'data-pp-clamp': '2' }, pulled.attribution)
        : null,
      pulled.source
        ? h('p', { class: 'pp-quote-source', 'data-pp-tx': 'panelMeta', 'data-pp-clamp': '1' }, pulled.source)
        : null)
      : null,
    provenanceLabel(pulled.rendition, ctx))
    : emptyState('This scene has no quote yet — attach a specimen with a quote block, or give the scene a headline.', { box: 'body' })), ctx), ctx);
}

/**
 * The quote, its attribution, and where it came from. Attribution is copied,
 * never supplied.
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {{text: string|null, attribution: string|null, source: string|null, kicker: string|null, rendition: any, fallback: boolean}}
 */
export function pullQuote(ctx) {
  const rends = Array.isArray(ctx.renditions) ? ctx.renditions.filter(Boolean) : [];
  for (let i = 0; i < rends.length; i++) {
    const found = firstOfType(Array.isArray(rends[i].blocks) ? rends[i].blocks : [], 'quote');
    if (found && found.block.text) {
      return {
        text: String(found.block.text),
        attribution: found.block.attribution ? String(found.block.attribution) : null,
        source: renditionLabel(rends[i], i),
        kicker: 'In their words',
        rendition: rends[i],
        fallback: false,
      };
    }
  }
  const fromSpecimen = ctx.specimen
    ? firstOfType(Array.isArray(ctx.specimen.blocks) ? ctx.specimen.blocks : [], 'quote')
    : null;
  if (fromSpecimen && fromSpecimen.block.text) {
    return {
      text: String(fromSpecimen.block.text),
      attribution: fromSpecimen.block.attribution ? String(fromSpecimen.block.attribution) : null,
      source: [specimenTitle(ctx.specimen), specimenMeta(ctx.specimen)].filter(Boolean).join('  ·  ') || null,
      kicker: 'In their words',
      rendition: null,
      fallback: false,
    };
  }
  // No quote in the model: the scene's own headline, set as a statement, with
  // no attribution — because there is nobody to attribute it to. The header
  // band is suppressed in that case so the headline is said once, not twice.
  if (ctx.scene && ctx.scene.headline) {
    return {
      text: String(ctx.scene.headline),
      attribution: null,
      source: ctx.scene.subhead
        ? String(ctx.scene.subhead)
        : (ctx.specimen ? specimenTitle(ctx.specimen) : null),
      kicker: null,
      rendition: null,
      fallback: true,
    };
  }
  return { text: null, attribution: null, source: null, kicker: null, rendition: null, fallback: false };
}

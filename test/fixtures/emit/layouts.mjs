/**
 * Stand-in layouts for the emitter's tests.
 *
 * L8 owns the eight real layouts. L10 must be testable before, during and after
 * L8 lands, and — more importantly — the emitter's laws must be tested against
 * markup the emitter does not control. These layouts therefore honour exactly
 * the contract API.md places on L8 and nothing more:
 *
 *   - every revealable element carries `data-pp-el` minted through `ctx.el()`;
 *   - every rendition subtree carries `data-pp-rendition`;
 *   - every illustrative rendition carries a `.pp-provenance` element inside
 *     that subtree when `ctx.labelIllustrative` is set.
 *
 * `attackLayouts()` breaks one of those on purpose, which is how
 * `test/emit/provenance.test.mjs` plants its attacks.
 */

import { h, raw } from '../../../src/core/vdom.js';
import { registerLayout, resetLayouts } from '../../../src/runtime/layouts.js';
import { SCENE_LAYOUTS } from '../../../src/core/contracts.js';
import { requiresProvenanceLabel } from '../../../src/emit/promotion.js';

/**
 * @param {object} [options]
 * @param {boolean} [options.omitLabel]        render no provenance label at all
 * @param {string} [options.labelStyle]        inline style applied to the label
 * @param {boolean} [options.labelEmptyText]   render a label with no text
 * @param {string} [options.ctaHref]           render a CTA anchor with this href
 * @param {boolean} [options.omitRenditionAttr] drop `data-pp-rendition`
 * @param {boolean} [options.renderRawBlocks]  emit `raw` ContentBlocks as raw HTML,
 *   which is the one way prospect-supplied markup can reach the document verbatim
 */
export function makeLayout(options = {}) {
  /** @param {import('../../../src/runtime/layouts.js').LayoutContext} ctx */
  return function layout(ctx) {
    const { scene, specimen, renditions, media, el, labelIllustrative } = ctx;

    const beforeBlocks = ((specimen && specimen.blocks) || []).map((block, i) => h(
      'div',
      { class: 'pp-block', 'data-pp-el': el(`before/block/${i}`) },
      block.type === 'heading' ? h('h2', null, block.text) : null,
      block.type === 'paragraph' ? h('p', null, block.text) : null,
      block.type === 'media' ? renderMedia(media.get(block.ref)) : null,
      block.type === 'cta' && options.ctaHref ? h('a', { href: options.ctaHref }, block.label) : null,
      block.type === 'raw' && options.renderRawBlocks ? raw(block.html) : null,
    ));

    const after = renditions.map((rendition, i) => {
      const needsLabel = labelIllustrative && requiresProvenanceLabel(rendition);
      const label = needsLabel && !options.omitLabel
        ? h('span', {
          class: 'pp-provenance',
          style: options.labelStyle || undefined,
        }, options.labelEmptyText ? '' : 'Illustrative — not client-approved')
        : null;
      const attrs = { class: 'pp-rendition', 'data-pp-el': el(`after/${i}`) };
      if (!options.omitRenditionAttr) attrs['data-pp-rendition'] = rendition.id;
      return h('figure', attrs,
        h('figcaption', null, rendition.label),
        label,
        ...(rendition.media || []).map((m) => renderMedia(m)),
        ...(rendition.blocks || []).map((b) => h('p', null, b.text || '')));
    });

    return h('div', { class: `pp-layout pp-layout--${scene.layout}` },
      scene.headline ? h('h1', { class: 'pp-headline', 'data-pp-el': el('headline') }, scene.headline) : null,
      scene.subhead ? h('p', { class: 'pp-subhead' }, scene.subhead) : null,
      h('div', { class: 'pp-before' }, beforeBlocks),
      h('div', { class: 'pp-after' }, after));
  };
}

/** @param {import('../../../src/core/contracts.d.ts').MediaRef|undefined} ref */
function renderMedia(ref) {
  if (!ref) return null;
  return h('img', { src: ref.dataUri, alt: ref.alt || '', width: ref.intrinsic.w, height: ref.intrinsic.h });
}

/**
 * Register the same layout under all eight §4 names.
 * @param {Parameters<typeof makeLayout>[0]} [options]
 * @returns {() => void}
 */
export function registerTestLayouts(options = {}) {
  resetLayouts();
  const fn = makeLayout(options);
  for (const name of SCENE_LAYOUTS) registerLayout(name, fn);
  return () => resetLayouts();
}

/**
 * `ContentBlock[]` → VNode.
 *
 * This is the only place in L8 that turns the prospect's content into markup,
 * and it is written under three constraints that are laws rather than style:
 *
 *  - **§18.3 — the "before" side is presented unmodified.** Nothing here
 *    rewrites, summarises, truncates-with-an-ellipsis-in-the-model, or
 *    re-orders a block. Where space runs out the CSS clamps and the clamp is
 *    *reported* to the overflow detector (`maxLines`), so a scene that cannot
 *    hold its content shows up as a finding instead of quietly losing a
 *    paragraph.
 *  - **Zero network (§13).** A `media` block renders an `<img>` only when its
 *    `MediaRef` is a `data:` URI; anything else renders a visible "not
 *    available" frame. A `cta` block renders its label and never its `href` —
 *    an artifact whose markup carries a live URL is a `NETWORK_REFERENCE` even
 *    if nothing clicks it. A `raw` block is rendered as *text*, never as
 *    markup (§8 makes raw HTML an explicit per-specimen opt-in the studio
 *    grants, and a layout is not where that decision gets made).
 *  - **Every run of text sits inside an element carrying `data-pp-tx`.** That
 *    attribute is what `scenes.css` styles and what `measureScene` reads back,
 *    so a text node that escaped it would be invisible to §22.2's detector.
 *    `test/scene/measure.test.mjs` walks the rendered tree and fails on any.
 *
 * @module scene/blocks
 */

import { h } from '../core/vdom.js';
import { flowAttrs, resolveFlow, firstFlow } from './direction.js';

/** Heading level → text role. Levels below 3 all share the smallest role. */
export function headingRole(level) {
  const n = Number(level) || 1;
  return n <= 1 ? 'bh1' : n === 2 ? 'bh2' : 'bh3';
}

/**
 * @typedef {object} BlockOptions
 * @property {Map<string, import('../core/contracts.d.ts').MediaRef>} [media]
 * @property {string|null} [id]           element id — the block becomes revealable
 * @property {string|null} [group]        beat group key for `buildScene`
 * @property {number} [clampParagraph]    `-webkit-line-clamp` for prose
 * @property {number} [clampHeading]
 * @property {number} [maxListItems]      list items rendered; the rest are counted, never dropped silently
 * @property {number} [maxTableRows]
 * @property {'full'|'condensed'} [density]
 * @property {boolean} [mediaTall]        media may take the full box height
 * @property {'ltr'|'rtl'|'auto'|null} [dir]   container direction, when the block declares none (C8)
 * @property {string|null} [lang]              container language, when the block declares none (C8)
 */

/**
 * Render one content block.
 * @param {import('../core/contracts.d.ts').ContentBlock} block
 * @param {BlockOptions} [options]
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderBlock(block, options = {}) {
  const o = options || {};
  const attrs = {
    class: `pp-block pp-block--${block && block.type ? block.type : 'unknown'}`,
    'data-pp-block': block && block.type ? block.type : 'unknown',
    ...directionOf(block, o),
  };
  if (o.id) {
    attrs['data-pp-el'] = o.id;
    if (o.group) attrs['data-pp-group'] = o.group;
  }
  return h('div', attrs, blockBody(block, o));
}

/**
 * The writing direction and language a block is to be rendered in (C8).
 *
 * §9.1 asks `locale-fanout` for "locale-appropriate structure, not just
 * translated strings", and an ar-SA rendition whose blocks arrive marked
 * `dir="rtl"` and then render left to right is the deck *describing* the
 * difference in a table row instead of *showing* it. §4's `ContentBlock` has no
 * direction, so L7 carries it as an optional extension (`dir`, `lang`) and this
 * is the half that honours it; the objection to the contract not carrying it is
 * filed in docs/disputes/L8-scenes.md.
 *
 * The block's own value wins over the container's, because a rendition mixes
 * the source's language with the tool's own structural labels and no single tag
 * is true of the whole of it. Nothing is invented: a block that declares
 * nothing, inside a rendition that declares nothing, gets no attribute at all
 * and inherits the document's direction exactly as before.
 *
 * @param {any} block
 * @param {{dir?: string|null, lang?: string|null}} o
 * @returns {{dir?: string, lang?: string}}
 */
export function directionOf(block, o = {}) {
  return flowAttrs(resolveFlow(block, o));
}

/**
 * `.pp-quote`'s rule gutter, both sides summed, in px: a 2px accent rule plus a
 * 12px inline-start pad. Stated here because the stylesheet states it in place;
 * `test/scene/geometry-browser.test.mjs` keeps the two equal.
 */
export const QUOTE_RULE_INSET_PX = 14;

/**
 * `.pp-cta`'s horizontal padding, both sides summed, in px. The rule around it
 * is the brand's and is measured separately — see `BRAND_BORDER_INSET`.
 */
export const CTA_PAD_PX = 28;

/**
 * `.pp-raw`'s inline-start gutter and dashed rule, in px: `padding-inline-start:
 * 10px` behind a `2px dashed` rule.
 */
export const RAW_RULE_INSET_PX = 12;

/**
 * The block's content, without the revealable wrapper.
 * @param {import('../core/contracts.d.ts').ContentBlock} block
 * @param {BlockOptions} o
 * @returns {import('../core/vdom.js').VNode}
 */
export function blockBody(block, o) {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(block.level) || 1));
      return h(`h${level}`, {
        class: 'pp-h',
        'data-pp-tx': headingRole(level),
        'data-pp-clamp': o.clampHeading || null,
      }, String(block.text ?? ''));
    }

    case 'paragraph':
      return h('p', {
        class: 'pp-p',
        'data-pp-tx': 'body',
        'data-pp-clamp': o.clampParagraph || null,
      }, String(block.text ?? ''));

    case 'list': {
      const items = Array.isArray(block.items) ? block.items : [];
      const limit = o.maxListItems && items.length > o.maxListItems ? o.maxListItems : items.length;
      const shown = items.slice(0, limit);
      const rest = items.length - shown.length;
      return h(block.ordered ? 'ol' : 'ul', { class: 'pp-list', 'data-pp-ordered': block.ordered ? 'true' : 'false' },
        shown.map((item, i) => h('li', { class: 'pp-list-item', 'data-pp-inset': 'list-marker-w' },
          h('span', { class: 'pp-list-marker', 'data-pp-tx': 'deco', 'data-pp-width': 'list-marker-w' }, block.ordered ? `${i + 1}.` : '•'),
          h('span', { class: 'pp-list-text', 'data-pp-tx': 'listItem', 'data-pp-clamp': o.clampParagraph || null }, String(item ?? '')))),
        rest > 0
          ? h('li', { class: 'pp-list-more', 'data-pp-inset': 'list-marker-w' },
            h('span', { class: 'pp-list-marker', 'data-pp-tx': 'deco', 'data-pp-width': 'list-marker-w' }, '·'),
            h('span', { class: 'pp-list-text', 'data-pp-tx': 'caption' }, `${rest} more ${rest === 1 ? 'item' : 'items'} in the source`))
          : null);
    }

    case 'quote':
      // `.pp-quote` sets `border-inline-start: 2px` and `padding-inline-start: 12px`.
      return h('blockquote', { class: 'pp-quote', 'data-pp-inset': String(QUOTE_RULE_INSET_PX) },
        h('p', { class: 'pp-quote-text', 'data-pp-tx': 'blockQuote', 'data-pp-clamp': o.clampParagraph || null }, String(block.text ?? '')),
        block.attribution
          ? h('p', { class: 'pp-quote-attr', 'data-pp-tx': 'blockAttribution' }, String(block.attribution))
          : null);

    case 'table': {
      const rows = Array.isArray(block.rows) ? block.rows.filter(Array.isArray) : [];
      const cols = rows.reduce((m, r) => Math.max(m, r.length), 0) || 1;
      const limit = o.maxTableRows && rows.length > o.maxTableRows ? o.maxTableRows : rows.length;
      const shown = rows.slice(0, limit);
      const rest = rows.length - shown.length;
      const headerRow = block.header && shown.length ? shown[0] : null;
      const bodyRows = block.header ? shown.slice(1) : shown;
      const cellAttrs = {
        'data-pp-frac': String(cols),
        'data-pp-inset': 'cell-pad,cell-pad',
        // `.pp-table th, .pp-table td { overflow-wrap: break-word }` — a column
        // in a narrow panel is often narrower than a single long word, and the
        // stylesheet breaks it rather than letting it run out of the cell. The
        // measurement has to say so or the detector reads a wrapped word as an
        // unbreakable overflow (CRITIQUE-1 F6).
        'data-pp-ow': 'break-word',
      };
      return h('div', { class: 'pp-table-wrap' },
        h('table', { class: 'pp-table', 'data-pp-cols': String(cols) },
          headerRow
            ? h('thead', null, h('tr', null, padRow(headerRow, cols).map((cell) =>
              h('th', { ...cellAttrs, 'data-pp-tx': 'cellHead', scope: 'col' }, cell))))
            : null,
          h('tbody', null, bodyRows.map((row) => h('tr', null, padRow(row, cols).map((cell) =>
            h('td', { ...cellAttrs, 'data-pp-tx': 'cell' }, cell)))))),
        rest > 0
          ? h('p', { class: 'pp-table-more', 'data-pp-tx': 'caption' }, `${rest} more ${rest === 1 ? 'row' : 'rows'} in the source`)
          : null);
    }

    case 'cta':
      // The label only. §13's scanner treats any absolute URL in the emitted
      // document as a network reference, and a proof does not need a live link
      // to show what the client's page asks a visitor to do.
      //
      // The pill is `inline-block` — as wide as its words — so what the model
      // reports is the room the pill has, not the box it happens to fill, and
      // it says so with `data-pp-fit`. The room is the column less the pill's
      // own gutters: `padding: 6px 14px` plus a rule of the *prospect's* border
      // width on each side, which is why that one is a named token rather than
      // a number (`BRAND_BORDER_INSET` in measure.js).
      return h('span', {
        class: 'pp-cta',
        'data-pp-tx': 'cta',
        'data-pp-inset': `${CTA_PAD_PX},brand-border`,
        'data-pp-fit': 'shrink',
      }, String(block.label ?? ''));

    case 'media': {
      const ref = o.media ? o.media.get(String(block.ref)) : null;
      const usable = ref && typeof ref.dataUri === 'string' && ref.dataUri.startsWith('data:');
      return h('figure', { class: `pp-figure${o.mediaTall ? ' pp-figure--tall' : ''}` },
        usable
          ? h('img', {
            class: 'pp-img',
            src: ref.dataUri,
            alt: ref.alt || '',
            width: ref.intrinsic && ref.intrinsic.w ? String(ref.intrinsic.w) : null,
            height: ref.intrinsic && ref.intrinsic.h ? String(ref.intrinsic.h) : null,
            loading: null,
          })
          : h('div', { class: 'pp-img-missing', role: 'img', 'aria-label': 'Image unavailable' },
            h('span', { class: 'pp-img-missing-text', 'data-pp-tx': 'caption' }, 'Image not included in this build')),
        block.caption
          ? h('figcaption', { class: 'pp-figcaption', 'data-pp-tx': 'caption', 'data-pp-clamp': o.clampParagraph || null }, String(block.caption))
          : null);
    }

    case 'raw':
      // §8: raw source is never presented as markup by a layout.
      // `.pp-raw` wears a 2px dashed rule and a 10px gutter on its inline start.
      return h('div', { class: 'pp-raw', 'data-pp-inset': String(RAW_RULE_INSET_PX) },
        h('p', { class: 'pp-raw-label', 'data-pp-tx': 'caption', dir: 'ltr', lang: 'en' }, 'Source markup, shown as text'),
        h('p', { class: 'pp-raw-text', 'data-pp-tx': 'body', 'data-pp-clamp': o.clampParagraph || null }, stripTags(block.html)));

    default:
      return null;
  }
}

/**
 * Render a run of blocks, one revealable element each when `id` supplies one.
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @param {BlockOptions & {id?: (index: number) => string|null, group?: (index: number) => string|null}} [options]
 * @returns {import('../core/vdom.js').VNode[]}
 */
export function renderBlocks(blocks, options = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  return list.map((block, i) => renderBlock(block, {
    ...options,
    id: typeof options.id === 'function' ? options.id(i) : null,
    group: typeof options.group === 'function' ? options.group(i) : null,
  }));
}

/**
 * The first block matching a type, for layouts that lead with one thing.
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @param {string} type
 * @returns {{block: import('../core/contracts.d.ts').ContentBlock, index: number}|null}
 */
export function firstOfType(blocks, type) {
  const list = Array.isArray(blocks) ? blocks : [];
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].type === type) return { block: list[i], index: i };
  return null;
}

/**
 * A one-line summary of a block set for a card or an index row: the first
 * heading, else the first paragraph, else the first text of any kind. Never
 * invented — if there is no text, there is no summary.
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @returns {{title: string|null, blurb: string|null}}
 */
export function summarize(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  let title = null;
  let blurb = null;
  for (const b of list) {
    if (!b) continue;
    if (!title && b.type === 'heading' && b.text) title = String(b.text);
    else if (!blurb && b.type === 'paragraph' && b.text) blurb = String(b.text);
    else if (!blurb && b.type === 'list' && Array.isArray(b.items) && b.items.length) blurb = String(b.items[0]);
    else if (!blurb && b.type === 'quote' && b.text) blurb = String(b.text);
    if (title && blurb) break;
  }
  if (!title && blurb) { title = blurb; blurb = null; }
  // The direction of the first block that declared one: a summary lifted out of
  // a right-to-left rendition is still that rendition's text (C8).
  return { title, blurb, ...firstFlow(list) };
}

/** @param {string[]} row @param {number} cols @returns {string[]} */
function padRow(row, cols) {
  const out = row.map((c) => String(c ?? ''));
  while (out.length < cols) out.push('');
  return out.slice(0, cols);
}

/**
 * Strip tags and collapse whitespace. Used only for `raw` blocks, which are
 * shown as text.
 * @param {string} html
 * @returns {string}
 */
export function stripTags(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

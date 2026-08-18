/**
 * DOM → `ContentBlock[]` (§4, §8).
 *
 * The normalizer is deliberately context-free per subtree: the blocks produced
 * for a node depend only on that node. That is what lets chrome stripping be
 * exactly reversible — the block stream of the whole page is the concatenation
 * of the block streams of its parts, so removing a subtree removes a
 * contiguous, identifiable slice of blocks and putting it back restores the
 * original stream (§8 "stripping is reversible").
 *
 * Rules the spec sets, implemented here:
 *   - heading hierarchy preserved; skipped levels repaired **only** behind an
 *     explicit flag, and the repair records what it changed so it is reversible;
 *   - whitespace collapsed, `<br>` kept as a paragraph break where it separates
 *     sentences and dropped where it is a line wrap inside one;
 *   - presentational spans unwrapped;
 *   - empty blocks dropped.
 */

import { escapeText } from '../core/vdom.js';
import {
  attrOf, childrenOf, identityString, isElement, isText, normalizeSpace,
  NON_RENDERED, PRESENTATIONAL, tagOf, textOf,
} from './dom.js';

/** Marker standing in for a `<br>` while inline content is flattened. */
const BR = '\u0001';

/** Text that reads as a call to action even without a button class. */
const CTA_TEXT = /^(get started|start (?:free|now|your)|learn more|read more|find out more|request (?:a )?(?:demo|quote|access)|book (?:a )?(?:demo|call|meeting)|contact (?:us|sales)|talk to (?:us|sales|an expert)|try (?:it )?(?:free|now)|buy now|add to (?:cart|bag|basket)|download(?: the)?.{0,24}|sign up|subscribe|see (?:pricing|plans|how it works)|explore .{0,30}|view (?:all|more|details|pricing)|get (?:a )?(?:quote|pricing|demo))$/i;

/** Class/role tokens that mark an anchor as a button rather than a link. */
const CTA_IDENTITY = /\b(btn|button|cta|call-to-action|action-link|link-button|pill|primary-action)\b/;

/**
 * Index the captured media so `<img src>` can be resolved to a `MediaRef` id.
 * Accepts a `MediaRef[]`, a `Map`, or a plain object keyed by src.
 * @param {any} media
 * @returns {Map<string, string>} lookup key → media id
 */
export function mediaIndex(media) {
  /** @type {Map<string, string>} */
  const index = new Map();
  const add = (key, id) => {
    if (!key || !id) return;
    const k = String(key);
    if (!index.has(k)) index.set(k, id);
    const base = k.split(/[?#]/)[0].split('/').pop();
    if (base && !index.has(base)) index.set(base, id);
  };
  /** @param {any} ref */
  const addRef = (ref) => {
    if (!ref || !ref.id) return;
    add(ref.id, ref.id);
    add(ref.src, ref.id);
    add(ref.name, ref.id);
    if (Array.isArray(ref.sources)) for (const s of ref.sources) add(s, ref.id);
  };
  if (!media) return index;
  if (media instanceof Map) {
    for (const [k, v] of media) {
      if (v && typeof v === 'object') { addRef(v); add(k, v.id); }
      else add(k, String(v));
    }
    return index;
  }
  if (Array.isArray(media)) { for (const ref of media) addRef(ref); return index; }
  if (typeof media === 'object') {
    if (Array.isArray(media.media)) { for (const ref of media.media) addRef(ref); return index; }
    for (const [k, v] of Object.entries(media)) {
      if (v && typeof v === 'object') { addRef(v); add(k, v.id); }
      else add(k, String(v));
    }
  }
  return index;
}

/** @param {any} node @returns {boolean} */
function isInline(node) {
  if (isText(node)) return true;
  if (!isElement(node)) return false;
  const tag = tagOf(node);
  return PRESENTATIONAL.has(tag) || tag === 'a' || tag === 'code' || tag === 'q' || tag === 'br' || tag === 'button';
}

/**
 * Flatten inline content to text, keeping `<br>` positions as markers and
 * unwrapping presentational elements.
 * @param {any[]} nodes
 * @returns {string}
 */
function inlineString(nodes) {
  /** @type {string[]} */
  const parts = [];
  const rec = (n) => {
    if (!n) return;
    if (n.type === 'comment') return;
    if (isText(n)) { parts.push(String(n.text ?? '')); return; }
    if (!isElement(n)) return;
    const tag = tagOf(n);
    if (NON_RENDERED.has(tag)) return;
    if (tag === 'br') { parts.push(BR); return; }
    if (tag === 'img') { const alt = attrOf(n, 'alt'); if (alt) parts.push(` ${alt} `); return; }
    for (const c of childrenOf(n)) rec(c);
  };
  for (const n of nodes) rec(n);
  return parts.join('');
}

/**
 * Split flattened inline text into paragraphs at the `<br>`s that separate
 * sentences. A double `<br>` is always a break. A single one breaks only when
 * the text before it ends a sentence or both sides are long enough to be
 * sentences in their own right — so a wrapped address or a two-line headline
 * stays one block.
 * @param {string} s
 * @returns {string[]}
 */
export function splitOnBreaks(s) {
  const parts = s.split(BR).map((p) => p.replace(/[ \t]+/g, ' '));
  /** @type {string[]} */
  const out = [];
  let cur = parts.length ? parts[0] : '';
  for (let i = 1; i < parts.length; i++) {
    const left = normalizeSpace(cur);
    const right = normalizeSpace(parts[i]);
    const hardBreak = parts[i] === '' || left === '';
    const sentenceEnd = /[.!?:;。！？]["'”’)\]]?$/.test(left);
    const bothLong = left.length >= 40 && right.length >= 40;
    if (hardBreak || sentenceEnd || bothLong) {
      if (left) out.push(left);
      cur = parts[i];
    } else {
      cur = `${cur} ${parts[i]}`;
    }
  }
  const last = normalizeSpace(cur);
  if (last) out.push(last);
  return out.filter(Boolean);
}

/** @param {any} node @returns {boolean} */
function ctaLike(node) {
  if (!isElement(node)) return false;
  const tag = tagOf(node);
  if (tag !== 'a' && tag !== 'button') return false;
  const role = (attrOf(node, 'role') || '').toLowerCase();
  if (tag === 'button' || role === 'button') return true;
  if (CTA_IDENTITY.test(identityString(node))) return true;
  const text = textOf(node);
  return text.length > 0 && text.length <= 60 && CTA_TEXT.test(text);
}

/** Resolve an `<img>`-ish element to a captured media id, or its raw src. */
function resolveMedia(node, index) {
  const candidates = [];
  for (const name of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
    const v = attrOf(node, name);
    if (v) candidates.push(v.trim());
  }
  const srcset = attrOf(node, 'srcset') || attrOf(node, 'data-srcset');
  if (srcset) {
    for (const part of srcset.split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) candidates.push(url);
    }
  }
  for (const c of candidates) {
    if (index.has(c)) return { ref: index.get(c), resolved: true, src: c };
    const base = c.split(/[?#]/)[0].split('/').pop();
    if (base && index.has(base)) return { ref: index.get(base), resolved: true, src: c };
  }
  return candidates.length ? { ref: candidates[0], resolved: false, src: candidates[0] } : null;
}

/**
 * Blocks with the source node that produced each one. `toBlocks` is this,
 * projected; chrome stripping needs the provenance to partition the stream.
 * @param {any} root
 * @param {{media?: any, repairHeadings?: boolean}} [options]
 * @returns {{block: any, node: any}[]}
 */
export function blocksWithTrace(root, options = {}) {
  const index = mediaIndex(options.media);
  /** @type {{block: any, node: any}[]} */
  const out = [];
  const emit = (block, node) => {
    if (block && !isEmptyBlock(block)) out.push({ block, node });
  };

  /**
   * @param {any[]} buffer inline nodes accumulated since the last block
   * @param {any} owner node the paragraph is attributed to
   */
  const flushInline = (buffer, owner) => {
    if (buffer.length === 0) return;
    const meaningful = buffer.filter((n) => !(isText(n) && normalizeSpace(n.text ?? '') === ''));
    // A lone button-ish link in block flow is a call to action, not a sentence.
    if (meaningful.length === 1 && ctaLike(meaningful[0])) {
      const node = meaningful[0];
      const label = textOf(node);
      if (label) {
        emit({ type: 'cta', label, href: tagOf(node) === 'a' ? (attrOf(node, 'href') || null) : null }, node);
        buffer.length = 0;
        return;
      }
    }
    for (const text of splitOnBreaks(inlineString(buffer))) emit({ type: 'paragraph', text }, owner);
    buffer.length = 0;
  };

  /** @param {any} node */
  const container = (node) => {
    /** @type {any[]} */
    const buffer = [];
    for (const child of childrenOf(node)) {
      if (child.type === 'comment') continue;
      if (isText(child)) {
        if (normalizeSpace(child.text ?? '')) buffer.push(child);
        continue;
      }
      if (!isElement(child)) continue;
      const tag = tagOf(child);
      if (NON_RENDERED.has(tag)) continue;
      if (tag === 'br') { buffer.push(child); continue; }
      if (isInline(child) && !isMediaWrapper(child, index)) { buffer.push(child); continue; }
      flushInline(buffer, node);
      block(child);
    }
    flushInline(buffer, node);
  };

  /** @param {any} node */
  const block = (node) => {
    const tag = tagOf(node);
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = normalizeSpace(inlineString(childrenOf(node)).split(BR).join(' '));
        emit({ type: 'heading', level: Number(tag[1]), text }, node);
        return;
      }
      case 'p': {
        const media = firstMedia(node, index);
        for (const text of splitOnBreaks(inlineString(childrenOf(node)))) emit({ type: 'paragraph', text }, node);
        if (media) emit(media.block, node);
        return;
      }
      case 'ul': case 'ol': case 'menu': {
        const items = listItems(node, index);
        emit({ type: 'list', ordered: tag === 'ol', items }, node);
        return;
      }
      case 'dl': {
        /** @type {string[]} */
        const items = [];
        let term = '';
        for (const child of childrenOf(node)) {
          if (!isElement(child)) continue;
          const t = tagOf(child);
          if (t === 'dt') term = textOf(child);
          else if (t === 'dd') {
            const def = textOf(child);
            items.push(term ? `${term} — ${def}` : def);
            term = '';
          }
        }
        emit({ type: 'list', ordered: false, items: items.filter(Boolean) }, node);
        return;
      }
      case 'blockquote': {
        emit(quoteBlock(node), node);
        return;
      }
      case 'table': {
        emit(tableBlock(node), node);
        return;
      }
      case 'figure': {
        const media = firstMedia(node, index);
        const captionNode = childrenOf(node).find((c) => tagOf(c) === 'figcaption');
        const caption = captionNode ? textOf(captionNode) : '';
        if (media) {
          emit(caption ? { ...media.block, caption } : media.block, node);
        } else if (caption) {
          emit({ type: 'paragraph', text: caption }, node);
        }
        return;
      }
      case 'img': case 'picture': {
        const media = firstMedia(node, index);
        if (media) emit(media.block, node);
        return;
      }
      case 'pre': {
        // Preformatted text is the one place where losing whitespace loses
        // meaning, so it is carried as `raw` rather than flattened.
        const text = rawTextOf(node);
        if (normalizeSpace(text)) emit({ type: 'raw', html: `<pre>${escapeText(text)}</pre>` }, node);
        return;
      }
      case 'a': case 'button': {
        const media = firstMedia(node, index);
        if (media) { emit(media.block, node); return; }
        const label = textOf(node);
        if (!label) return;
        if (ctaLike(node)) emit({ type: 'cta', label, href: tag === 'a' ? (attrOf(node, 'href') || null) : null }, node);
        else emit({ type: 'paragraph', text: label }, node);
        return;
      }
      case 'hr': case 'input': case 'select': case 'textarea': case 'svg': case 'video': case 'audio':
        return;
      case 'li': case 'dt': case 'dd':
        container(node);
        return;
      default:
        container(node);
    }
  };

  if (isElement(root)) block(root);
  else container(root);

  const blocks = out;
  if (options.repairHeadings) repairHeadingLevels(blocks.map((e) => e.block));
  return blocks;
}

/** @param {any} node @returns {string} */
function rawTextOf(node) {
  /** @type {string[]} */
  const parts = [];
  const rec = (n) => {
    if (!n || n.type === 'comment') return;
    if (isText(n)) { parts.push(String(n.text ?? '')); return; }
    if (!isElement(n)) return;
    if (NON_RENDERED.has(tagOf(n))) return;
    if (tagOf(n) === 'br') { parts.push('\n'); return; }
    for (const c of childrenOf(n)) rec(c);
  };
  rec(node);
  return parts.join('').replace(/^\n+|\s+$/g, '');
}

/** True when an inline element exists only to carry an image. */
function isMediaWrapper(node, index) {
  if (tagOf(node) !== 'a') return false;
  const kids = childrenOf(node).filter((c) => isElement(c) || (isText(c) && normalizeSpace(c.text ?? '')));
  return kids.length > 0 && kids.every((c) => tagOf(c) === 'img' || tagOf(c) === 'picture') && Boolean(firstMedia(node, index));
}

/** @returns {{block: any}|null} */
function firstMedia(node, index) {
  /** @type {any|null} */
  let img = null;
  const rec = (n) => {
    if (img || !isElement(n)) return;
    if (tagOf(n) === 'img') { img = n; return; }
    for (const c of childrenOf(n)) rec(c);
  };
  if (tagOf(node) === 'img') img = node; else rec(node);
  if (!img) return null;
  const resolved = resolveMedia(img, index);
  if (!resolved) return null;
  /** @type {any} */
  const block = { type: 'media', ref: resolved.ref };
  if (!resolved.resolved) block.unresolved = true;
  const alt = attrOf(img, 'alt');
  if (alt && normalizeSpace(alt)) block.caption = normalizeSpace(alt);
  return { block };
}

/**
 * List items, with nested lists flattened into the parent list and marked by an
 * em-dash prefix per level (D-L6-4) — `ContentBlock.list.items` is `string[]`,
 * so nesting has to be carried in the text or thrown away, and thrown away is
 * worse.
 * @param {any} node
 * @param {Map<string, string>} index
 * @param {number} [depth]
 * @returns {string[]}
 */
function listItems(node, index, depth = 0) {
  /** @type {string[]} */
  const items = [];
  const prefix = depth > 0 ? `${'— '.repeat(depth)}` : '';
  for (const li of childrenOf(node)) {
    if (!isElement(li) || tagOf(li) !== 'li') continue;
    const own = [];
    /** @type {any[]} */
    const nested = [];
    for (const c of childrenOf(li)) {
      const t = tagOf(c);
      if (t === 'ul' || t === 'ol') nested.push(c);
      else own.push(c);
    }
    const text = normalizeSpace(inlineString(own).split(BR).join(' '));
    if (text) items.push(prefix + text);
    for (const sub of nested) items.push(...listItems(sub, index, depth + 1));
  }
  return items;
}

/** @param {any} node @returns {any} */
function quoteBlock(node) {
  /** @type {any[]} */
  const body = [];
  /** @type {string[]} */
  const attributions = [];
  const rec = (n) => {
    for (const c of childrenOf(n)) {
      const t = tagOf(c);
      if (t === 'cite' || t === 'footer') attributions.push(textOf(c));
      else body.push(c);
    }
  };
  rec(node);
  const text = normalizeSpace(splitOnBreaks(inlineString(body)).join(' ')) || textOf(node);
  const attribution = normalizeSpace(attributions.join(' ')).replace(/^[—–-]\s*/, '');
  /** @type {any} */
  const block = { type: 'quote', text };
  if (attribution) block.attribution = attribution;
  return block;
}

/**
 * Table rows. `header` is true when a `<thead>` row exists or the first row is
 * all `<th>`. `colspan` repeats the cell so rows stay rectangular; `rowspan` is
 * not expanded (D-L6-5).
 * @param {any} node
 * @returns {any}
 */
function tableBlock(node) {
  /** @type {any[]} */
  const rows = [];
  let header = false;
  const rowNodes = [];
  const collect = (n, inHead) => {
    for (const c of childrenOf(n)) {
      if (!isElement(c)) continue;
      const t = tagOf(c);
      if (t === 'tr') rowNodes.push({ node: c, inHead });
      else if (t === 'thead') collect(c, true);
      else if (t === 'tbody' || t === 'tfoot') collect(c, false);
    }
  };
  collect(node, false);
  for (const { node: tr, inHead } of rowNodes) {
    /** @type {string[]} */
    const cells = [];
    let allTh = true;
    for (const cell of childrenOf(tr)) {
      const t = tagOf(cell);
      if (t !== 'td' && t !== 'th') continue;
      if (t !== 'th') allTh = false;
      const text = normalizeSpace(inlineString(childrenOf(cell)).split(BR).join(' '));
      const span = Math.max(1, Math.min(20, parseInt(attrOf(cell, 'colspan') || '1', 10) || 1));
      for (let i = 0; i < span; i++) cells.push(text);
    }
    if (cells.length === 0) continue;
    if (rows.length === 0 && (inHead || allTh)) header = true;
    rows.push(cells);
  }
  return { type: 'table', rows, header };
}

/** @param {any} block @returns {boolean} */
export function isEmptyBlock(block) {
  if (!block) return true;
  switch (block.type) {
    case 'heading': case 'paragraph': return !normalizeSpace(block.text);
    case 'quote': return !normalizeSpace(block.text);
    case 'list': return !Array.isArray(block.items) || block.items.filter(Boolean).length === 0;
    case 'table': return !Array.isArray(block.rows) || block.rows.length === 0;
    case 'cta': return !normalizeSpace(block.label);
    case 'media': return !block.ref;
    case 'raw': return !normalizeSpace(String(block.html).replace(/<[^>]*>/g, ' '));
    default: return true;
  }
}

/**
 * §8: "repair skipped levels only with an explicit, reversible flag."
 *
 * Mutates in place, recording the original level on `repairedFrom` so
 * `unrepairHeadingLevels` is an exact inverse.
 * @param {any[]} blocks
 * @returns {{repaired: number}}
 */
export function repairHeadingLevels(blocks) {
  let previous = 0;
  let repaired = 0;
  for (const b of blocks) {
    if (!b || b.type !== 'heading') continue;
    const level = b.level;
    if (previous === 0) {
      previous = level;
      continue;
    }
    if (level > previous + 1) {
      const next = previous + 1;
      b.repairedFrom = level;
      b.level = next;
      repaired += 1;
      previous = next;
    } else {
      previous = level;
    }
  }
  return { repaired };
}

/**
 * Undo `repairHeadingLevels`.
 * @param {any[]} blocks
 * @returns {{restored: number}}
 */
export function unrepairHeadingLevels(blocks) {
  let restored = 0;
  for (const b of blocks) {
    if (b && b.type === 'heading' && typeof b.repairedFrom === 'number') {
      b.level = b.repairedFrom;
      delete b.repairedFrom;
      restored += 1;
    }
  }
  return { restored };
}

/**
 * §8 / API.md L6 — normalize a subtree into the frozen `ContentBlock[]` union.
 * @param {any} root
 * @param {{media?: any, repairHeadings?: boolean}} [options]
 * @returns {import('../core/contracts.d.ts').ContentBlock[]}
 */
export function toBlocks(root, options = {}) {
  return blocksWithTrace(root, options).map((e) => e.block);
}

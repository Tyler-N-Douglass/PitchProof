/**
 * The Specimens panel (§6 ingest, §8 capture).
 *
 * The library on the left of the section, the selected specimen's contents
 * below it. Three §8 obligations are surfaced rather than assumed:
 *
 *   - **the chrome-stripping result is shown**, with the reason and the score
 *     that removed each block, and **every stripped block is restorable** —
 *     individually or all at once. Under-stripping poisons every specimen
 *     downstream (§22.3), and a reviewer who cannot see what was taken cannot
 *     catch over-stripping either.
 *   - **raw HTML is opt-in per specimen**, and the opt-in records who and when.
 *   - **an edited specimen says so.** §18.3 requires the artifact to admit it,
 *     so every text edit stamps the specimen and the stamp is visible here.
 *   - **an image the capture could not bring says so, and has a way back.**
 *     L6 holds a `media` block whose bytes were never captured out of the block
 *     stream (its D-L6-21, for CRITIQUE-3 P6) — right, and silent until a
 *     screen shows it. A capture that quietly dropped the product photograph
 *     and then emitted cleanly is a worse failure than the emit blocker it
 *     replaced, because the blocker at least stopped the seller.
 *
 * @module ui/panels/specimens
 */

import { h, cx } from '../../core/vdom.js';
import {
  badge, button, checkbox, empty, field, notice, pair, pairs, rawBox, row, section, select, textarea, toolbar,
} from '../components.js';
import { formatBytes, formatDate, formatDateTime, plural, truncate } from '../format.js';
import {
  blockEditableText, blockIsPreformatted, blockSummary, blockUsesMonospace,
  findSpecimen, rawOptIn, specimenIsEdited, strippedBlocks,
} from '../model.js';
import { IMAGE_ACCEPT, KIND_CHOICES } from '../actions.js';
import { ACT_ATTR, ARG_ATTR, KEY_ATTR } from '../render.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderSpecimensPanel(app) {
  const specimens = app.proof.specimens || [];
  const selected = findSpecimen(app.proof, app.ui.selection.specimenId) || specimens[0] || null;

  return h('div', { class: 'st-panel' },
    renderCapture(app),
    renderLibrary(app, specimens, selected),
    selected ? renderSpecimen(app, selected) : null);
}

/** @param {any} app */
function renderCapture(app) {
  const suggestions = app.ui.sitemap || [];
  return section({
    title: 'Capture',
    subtitle: 'Fetch, saved page, HAR, MHTML, deck, PDF, image, or paste. None of them dead-ends (§6).',
    actions: toolbar(
      button({ act: 'specimen.capture', variant: 'primary', title: 'Capture the page (Enter, from the address field)', disabled: app.isBusy('specimen.capture') },
        app.isBusy('specimen.capture') ? 'Capturing…' : 'Capture'),
      button({ act: 'specimen.sitemap', variant: 'ghost', title: 'Rank the site’s pages by structural richness' }, 'Suggest pages'),
    ),
  },
  field({
    label: 'Page address', act: 'specimen.urlDraft', value: app.draft('specimen.url', ''),
    placeholder: 'https://www.example.com/products/x', key: 'spec-url', enter: 'specimen.capture',
    hint: 'Press Enter to capture.',
  }),
  suggestions.length
    ? h('div', { class: 'st-suggestions' },
      h('span', { class: 'st-field-label' }, `${plural(suggestions.length, 'candidate')}, richest first`),
      h('ul', { class: 'st-suggestion-list' }, suggestions.map((s) => h('li', { [KEY_ATTR]: s.url || s.loc },
        h('button', {
          type: 'button', class: 'st-suggestion',
          [ACT_ATTR]: 'specimen.useSuggestion', [ARG_ATTR]: s.url || s.loc,
        },
        h('span', { class: 'st-suggestion-url st-mono' }, truncate(s.url || s.loc, 64)),
        s.score !== undefined ? h('span', { class: 'st-suggestion-score st-mono' }, Number(s.score).toFixed(2)) : null)))))
    : null,
  h('label', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, 'Or drop files'),
    h('input', {
      class: 'st-input st-file', type: 'file', multiple: true,
      [ACT_ATTR]: 'specimen.importFiles', [KEY_ATTR]: 'spec-files',
    }),
    h('span', { class: 'st-field-hint' }, '.html + assets folder, .har, .mhtml, .docx, .pptx, .pdf, or images.')),
  textarea({
    label: 'Or paste the page source', act: 'specimen.pasteDraft', rows: 5, mono: true,
    value: app.draft('specimen.html', ''), key: 'spec-paste',
    placeholder: '<!doctype html>…',
    hint: 'View source, select all, paste. Works when nothing else does.',
  }),
  toolbar(button({ act: 'specimen.importPaste', variant: 'ghost' }, 'Capture from the paste')),
  app.services.has('ingest') ? null : notice('warn', 'The ingest lane is not wired into this build, so capture is unavailable. Everything below still works on specimens already in the project.'));
}

/**
 * @param {any} app
 * @param {any[]} specimens
 * @param {any} selected
 */
function renderLibrary(app, specimens, selected) {
  return section({
    title: 'Library',
    subtitle: `${plural(specimens.length, 'specimen')} captured.`,
  },
  specimens.length
    ? h('div', { class: 'st-rows' }, specimens.map((s) => {
      const stripped = strippedBlocks(s);
      return row({
        act: 'specimen.select', arg: s.id, key: s.id, selected: !!selected && s.id === selected.id,
        title: h('span', null,
          truncate(s.title, 44),
          specimenIsEdited(s) ? badge('edited', 'warn', '§18.3: the artifact will say this specimen was edited.') : null,
          rawOptIn(s).allowed ? badge('raw on', 'warn') : null),
        meta: h('span', null,
          `${s.kind} · ${plural((s.blocks || []).length, 'block')} · ${plural(s.wordCount || 0, 'word')}`,
          stripped.length ? ` · ${plural(stripped.length, 'block')} stripped` : '',
          s.locale ? ` · ${s.locale}` : '',
          ` · ${formatDate(s.capturedAt)}`),
        trailing: button({ act: 'specimen.remove', arg: s.id, variant: 'quiet', title: `Remove ${s.title}` }, '×'),
      });
    }))
    : empty('Nothing captured yet. A proof built on their own pages is the whole point — start with the page they are proudest of.'));
}

/**
 * @param {any} app
 * @param {any} specimen
 */
function renderSpecimen(app, specimen) {
  const stripped = strippedBlocks(specimen);
  const opt = rawOptIn(specimen);
  const mediaBytes = (specimen.media || []).reduce((n, m) => n + (m.bytes || 0), 0);

  return h('div', null,
    section({
      title: truncate(specimen.title, 48),
      subtitle: specimen.sourceUrl || 'No source URL — imported from a file.',
    },
    h('div', { class: 'st-grid-2' },
      field({
        label: 'Title', act: 'specimen.setTitle', arg: specimen.id, value: specimen.title,
        key: `spec-title-${specimen.id}`,
      }),
      select({
        label: 'Kind', act: 'specimen.setKind', arg: specimen.id, value: specimen.kind,
        options: KIND_CHOICES, key: `spec-kind-${specimen.id}`,
      })),
    pairs(
      pair('Captured', formatDateTime(specimen.capturedAt)),
      pair('Locale', h('span', { class: 'st-mono' }, specimen.locale || '—')),
      pair('Words', h('span', { class: 'st-mono' }, String(specimen.wordCount || 0))),
      pair('Media', h('span', { class: 'st-mono' }, `${(specimen.media || []).length} · ${formatBytes(mediaBytes)}`)),
      pair('Chrome locator', h('span', { class: 'st-mono' }, (specimen.chrome && specimen.chrome.locator) || '—')),
    ),
    specimenIsEdited(specimen)
      ? notice('warn', h('div', null,
        h('p', null, '§18.3: this specimen has been edited, and the artifact will say so.'),
        (specimen.editNotes || []).length
          ? h('ul', { class: 'st-paths' }, specimen.editNotes.map((n, i) => h('li', { [KEY_ATTR]: String(i) }, n)))
          : null))
      : null),

    renderOmittedMedia(app, specimen),

    section({
      title: 'What was stripped as chrome',
      subtitle: 'Every removal carries the reason and the score that made it, and every one is reversible (§8).',
      actions: stripped.length
        ? toolbar(button({ act: 'specimen.restoreAll', arg: specimen.id, variant: 'ghost' }, 'Restore all'))
        : null,
    },
    stripped.length
      ? h('ul', { class: 'st-stripped' }, stripped.map((entry, i) => h('li', { class: 'st-stripped-item', [KEY_ATTR]: entry.id || String(i) },
        h('div', { class: 'st-stripped-head' },
          badge(entry.reason || 'chrome', 'warn'),
          h('span', { class: 'st-stripped-score st-mono' }, `score ${Number(entry.score ?? 0).toFixed(2)}`),
          entry.selector ? h('code', { class: 'st-mono st-dim' }, truncate(entry.selector, 40)) : null,
          button({ act: 'specimen.restore', arg: `${specimen.id}:${i}`, variant: 'ghost' }, 'Restore')),
        h('p', { class: 'st-stripped-text' }, truncate(entry.text || (entry.blocks || []).map(blockSummary).join(' · '), 220)))))
      : notice('info', (specimen.chrome && specimen.chrome.removedCount === 0)
        ? 'Nothing was stripped. Either the page is unusually clean or the capture arrived as blocks from a document importer.'
        : 'Nothing is currently stripped from this specimen.')),

    section({
      title: `Content · ${plural((specimen.blocks || []).length, 'block')}`,
      subtitle: 'Their words. The “before” side of every scene renders these unmodified unless you change them here (§18.3).',
    },
    (specimen.blocks || []).length
      ? h('ol', { class: 'st-blocks' }, specimen.blocks.map((block, i) => h('li', { class: 'st-block', [KEY_ATTR]: `${specimen.id}:${i}` },
        h('div', { class: 'st-block-head' },
          badge(block.type, 'dim'),
          block.type === 'heading' ? h('span', { class: 'st-mono st-dim' }, `h${block.level}`) : null,
          blockIsPreformatted(block) ? h('span', { class: 'st-mono st-dim', title: 'Preformatted: the spacing in this text is part of it, so this field keeps its columns.' }, 'pre') : null,
          h('div', { class: 'st-block-tools' },
            button({ act: 'specimen.moveBlock', arg: `${specimen.id}:${i}:-1`, variant: 'quiet', title: 'Move up', disabled: i === 0 }, '↑'),
            button({ act: 'specimen.moveBlock', arg: `${specimen.id}:${i}:1`, variant: 'quiet', title: 'Move down', disabled: i === specimen.blocks.length - 1 }, '↓'),
            button({ act: 'specimen.removeBlock', arg: `${specimen.id}:${i}`, variant: 'quiet', title: 'Delete this block' }, '×'))),
        h('textarea', {
          class: cx('st-input', 'st-textarea', 'st-block-text',
            blockUsesMonospace(block) && 'st-mono',
            blockIsPreformatted(block) && 'st-block-text--pre'),
          rows: String(blockRows(block)),
          value: blockEditableText(block),
          'aria-label': `${blockIsPreformatted(block) ? 'preformatted ' : ''}${block.type} block ${i + 1}`,
          [ACT_ATTR]: 'specimen.setBlockText',
          [ARG_ATTR]: `${specimen.id}:${i}`,
          [KEY_ATTR]: `blocktext-${specimen.id}-${i}`,
        }))))
      : empty('This specimen has no blocks. The rehearsal sweep raises SPECIMEN_EMPTY for it.')),

    section({
      title: 'Raw HTML',
      subtitle: '§8 keeps the untouched source, and never presents it without a per-specimen opt-in.',
    },
    checkbox({
      label: 'Allow this specimen’s raw HTML to render in a scene',
      act: 'specimen.rawOptIn',
      arg: specimen.id,
      checked: opt.allowed,
      hint: opt.allowed
        ? `Opted in by ${opt.by} at ${formatDateTime(opt.at)}.`
        : 'Recorded against your name and the time. Set your name in Settings first.',
    }),
    opt.allowed && specimen.raw
      ? h('details', { class: 'st-details' },
        h('summary', null, `Raw source · ${formatBytes(String(specimen.raw).length)}`),
        rawBox(escapeForPreview(specimen.raw), 'st-raw-source'))
      : null,
    !specimen.raw ? notice('info', 'No raw HTML was captured for this specimen — it came from a document or image importer.') : null));
}

/**
 * The images this capture could not bring, and the way to bring them.
 *
 * §6's paste route — the one the studio's own copy calls "Works when nothing
 * else does" — has markup and no bytes, so every image on the page arrives as a
 * reference to a file that is not there. L6 holds those blocks back; this is
 * where the seller finds out, and it is the only screen that says so.
 *
 * Each entry carries a file picker rather than a message, because a message
 * alone would leave the seller with a deck they now know is missing the product
 * photograph and no way to put it in. `restoreOmittedMedia` returns the block
 * to the exact position it was taken from, with its caption, so supplying the
 * file is a repair rather than a re-edit.
 *
 * An entry that is `restorable: false` is a `media` block still standing in the
 * stream whose `ref` resolves to nothing. There is no held-back position to
 * return it to, so it gets the sentence and no picker: the sweep raises
 * `ASSET_MISSING` for it, and that is the honest route.
 *
 * @param {any} app
 * @param {any} specimen
 */
function renderOmittedMedia(app, specimen) {
  const omitted = app.services.omittedMedia(specimen) || [];
  if (!omitted.length) return null;
  const restorable = omitted.filter((e) => e.restorable);
  return section({
    title: `Images this capture could not bring · ${omitted.length}`,
    subtitle: 'Pasted markup carries no bytes, so an image on the page arrives as a reference to a file that is not here (§6).',
  },
  notice('warn', restorable.length
    ? `${plural(omitted.length, 'image')} ${omitted.length === 1 ? 'was' : 'were'} left out of the content below rather than shown to the client as ${omitted.length === 1 ? 'a broken picture' : 'broken pictures'}. The proof will emit without ${omitted.length === 1 ? 'it' : 'them'} and say nothing on stage, so this is the screen that says it. Supply the file and the image goes back exactly where it stood, with its caption.`
    : `${plural(omitted.length, 'image')} ${omitted.length === 1 ? 'is' : 'are'} referenced by a block in this specimen with no file behind ${omitted.length === 1 ? 'it' : 'them'}. The rehearsal sweep raises ASSET_MISSING for ${omitted.length === 1 ? 'it' : 'them'}, and the emit stays closed until ${omitted.length === 1 ? 'it is' : 'they are'} resolved.`),
  h('ul', { class: 'st-omitted' }, omitted.map((entry, i) => h('li', {
    class: 'st-omitted-item', [KEY_ATTR]: entry.id || `${entry.ref}:${i}`,
  },
  h('div', { class: 'st-omitted-head' },
    badge(entry.restorable ? 'left out' : 'unresolved', 'warn'),
    h('code', { class: 'st-mono' }, truncate(entry.ref, 56)),
    entry.position === null ? null : h('span', { class: 'st-dim st-mono' }, `position ${entry.position}`),
    entry.origin === 'stripped' ? h('span', { class: 'st-dim' }, 'inside a stripped region') : null),
  entry.caption ? h('p', { class: 'st-omitted-caption' }, `“${truncate(entry.caption, 120)}”`) : null,
  entry.restorable
    ? h('label', { class: 'st-field' },
      h('span', { class: 'st-field-label' }, 'Supply this image'),
      h('input', {
        class: 'st-input st-file', type: 'file', accept: IMAGE_ACCEPT,
        [ACT_ATTR]: 'specimen.supplyMedia',
        [ARG_ATTR]: `${specimen.id}|${entry.id || entry.ref}`,
        [KEY_ATTR]: `omitted-${specimen.id}-${entry.id || i}`,
        'aria-label': `Supply the image file for ${entry.ref}`,
      }),
      h('span', { class: 'st-field-hint' }, '.png, .jpg, .webp, .gif, .avif or .svg. It goes back at the position above, with its caption, and does not mark the specimen edited — it is their picture arriving, not a change to their page.'))
    : h('p', { class: 'st-field-hint' }, 'This one is referenced by a block rather than held back, so there is no recorded position to return it to. Remove the block, or re-capture the page with its assets folder.')))));
}

/**
 * How tall to draw a block's editor. Prose is measured in characters, because
 * it soft-wraps at the field's width; a preformatted block is measured in
 * lines, because it does not wrap at all and a wrapped estimate would size a
 * six-line table at two rows. Both are clamped so one long block cannot push
 * the rest of the specimen off the panel.
 * @param {import('../../core/contracts.d.ts').ContentBlock} block
 * @returns {number}
 */
function blockRows(block) {
  const text = blockEditableText(block);
  if (blockIsPreformatted(block)) return Math.min(12, Math.max(2, text.split('\n').length));
  return Math.min(8, Math.max(2, Math.ceil(text.length / 70)));
}

/**
 * Show raw markup as text rather than rendering it. The studio previews the
 * artifact through the real runtime; a raw block dumped into the studio's own
 * document would be neither.
 * @param {string} html
 * @returns {string}
 */
function escapeForPreview(html) {
  return `<pre class="st-pre">${String(html)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 40000)}</pre>`;
}

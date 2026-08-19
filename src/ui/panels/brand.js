/**
 * The Brand panel (§7).
 *
 * §7 asks for four things the studio must show rather than merely hold, and
 * this panel is where all four live:
 *
 *   - **every colour role with its computed contrast against its pair.** The
 *     number comes from `brand/color.js`, never from an estimate; when the
 *     colour lane is not wired the column reads `—` rather than a plausible
 *     figure, because a made-up contrast ratio is worse than none.
 *   - **every face with its resolved fallback and `metricDelta`.** The fallback
 *     is what will actually render, and the delta is the number that predicts
 *     the overflow §22.2 calls the defect that matters most.
 *   - **low-confidence fields surfaced for review, and held out of an emit
 *     until reviewed.** The review checkbox is the release; the emit gate reads
 *     the same state.
 *   - **manual override of any field, with the path recorded** in
 *     `manualOverrides`, so the artifact's provenance story stays honest.
 *
 * @module ui/panels/brand
 */

import { h, cx } from '../../core/vdom.js';
import {
  badge, button, checkbox, empty, field, notice, pair, pairs, rawBox, section, select, swatch, toolbar,
} from '../components.js';
import { FONT_ACCEPT } from '../actions.js';
import { formatBytes, formatDateTime, formatMetric, formatPercent, formatRatio, humanize } from '../format.js';
import {
  BRAND_GROUPS, LOW_CONFIDENCE, brandGroupEvidence, brandGroupIsStarterDefault, brandIsUntouched,
  pairedRole, reviewedGroups, unreviewedBrandGroups,
} from '../model.js';
import { COLOR_ROLES, CONTRAST_AA_BODY, FOREGROUND_ROLES } from '../../core/contracts.js';
import { ACT_ATTR, ARG_ATTR, KEY_ATTR } from '../render.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderBrandPanel(app) {
  const brand = app.proof.brand;
  const reviewed = new Set(reviewedGroups(brand));
  const pending = unreviewedBrandGroups(brand);

  const contrast = app.services.checkContrast(brand);

  return h('div', { class: 'st-panel' },
    renderExtract(app, brand),
    contrast.length ? renderContrastFindings(contrast) : null,
    pending.length ? renderReviewGate(app, brand, pending) : null,
    renderColors(app, brand),
    renderFaces(app, brand),
    renderLogos(app, brand),
    renderShapeAndImagery(app, brand),
    renderConfidence(app, brand, reviewed),
    renderOverrides(brand));
}

/**
 * @param {any} app
 * @param {any} brand
 */
function renderExtract(app, brand) {
  const proxy = app.ui.settings.proxyBase;
  return section({
    title: 'Extract',
    subtitle: 'A URL, or the files they sent you. Both degrade rather than dead-ending (§6).',
    actions: toolbar(button({
      act: 'brand.extract', variant: 'primary',
      title: 'Extract the brand system (Enter, from the address field)',
      disabled: app.isBusy('brand.extract'),
    }, app.isBusy('brand.extract') ? 'Extracting…' : 'Extract')),
  },
  field({
    label: 'Site address', act: 'brand.urlDraft', value: app.draft('brand.url', brand.sourceUrl || ''),
    placeholder: 'https://www.example.com', key: 'brand-url', enter: 'brand.extract',
    hint: proxy
      ? `Press Enter to extract. A direct fetch is tried first, then your proxy at ${proxy}.`
      : 'Press Enter to extract. A direct fetch is tried first; most enterprise sites refuse it, which is normal rather than an error. Set a CORS proxy in Settings, or drop the saved page below.',
  }),
  h('label', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, 'Or drop the saved page, a .har, a .mhtml, a deck or a PDF'),
    h('input', {
      class: 'st-input st-file', type: 'file', multiple: true,
      [ACT_ATTR]: 'brand.extractFiles', [KEY_ATTR]: 'brand-files',
    }),
    h('span', { class: 'st-field-hint' }, 'Save the page from the browser (⌘S / Ctrl S) and drop the .html with its assets folder.')),
  field({
    label: 'Recorded source', act: 'brand.setSourceUrl', value: brand.sourceUrl || '',
    key: 'brand-source', mono: true,
    hint: 'What the artifact will say this brand was read from.',
  }),
  app.services.has('color') ? null : notice('warn', 'The colour lane is not wired into this build, so contrast is shown as “—” rather than guessed, and extraction is unavailable. Manual entry below still works.'),
  renderStrategies(app));
}

/**
 * L11's contrast verdict on the palette as it stands, without a sweep.
 *
 * §22.1 names naive palette swapping as the first thing that goes wrong, and it
 * goes wrong silently. Running the real check here means the number a user sees
 * beside the hex they just typed is the same number that will close the emit.
 * @param {any[]} findings
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderContrastFindings(findings) {
  const blocking = findings.filter((f) => f.severity === 1);
  return section({
    title: `Contrast · ${findings.length}`,
    subtitle: 'Checked by the same rule the rehearsal sweep uses, so this cannot disagree with it.',
  },
  notice(blocking.length ? 'bad' : 'warn', blocking.length
    ? `${blocking.length === 1 ? 'One pair' : `${blocking.length} pairs`} of this palette fail at severity 1. The emit is closed until they pass — derive a compliant colour, or change the pair.`
    : 'Nothing here blocks an emit, but these pairs are worth looking at before a projector does it for you.'),
  h('ul', { class: 'st-findings' }, findings.map((f) => h('li', {
    class: cx('st-finding', `st-finding--s${f.severity}`), [KEY_ATTR]: f.id,
  },
  h('div', { class: 'st-finding-head' },
    badge(f.code, f.severity === 1 ? 'bad' : 'warn'),
    h('span', { class: 'st-finding-message' }, f.message))))));
}

/**
 * The §7 gate, stated plainly: what is uncertain, why it matters, and the one
 * control that releases it.
 * @param {any} app
 * @param {any} brand
 * @param {{group: string, confidence: number}[]} pending
 */
function renderReviewGate(app, brand, pending) {
  const reviewable = pending.filter((entry) => brandGroupEvidence(brand, entry.group).hasContent);
  const empty = pending.filter((entry) => !brandGroupEvidence(brand, entry.group).hasContent);
  // A group still holding the values every new project starts with has not been
  // measured at all. Grouping it with genuinely low-confidence results would
  // have the panel report a failed extraction where no extraction was run.
  const starter = reviewable.filter((entry) => brandGroupIsStarterDefault(brand, entry.group));
  const measured = reviewable.filter((entry) => !brandGroupIsStarterDefault(brand, entry.group));

  return section({
    title: 'Waiting for your review',
    subtitle: '§7 holds low-confidence fields out of an emit until you have looked at them.',
    actions: reviewable.length
      ? toolbar(button({ act: 'brand.reviewAll', variant: 'primary' },
        reviewable.length === 1 ? 'I have checked this one' : 'I have checked all of these'))
      : null,
  },
  empty.length
    ? notice('bad', h('div', null,
      h('p', null, `${empty.length === 1 ? 'One group holds' : `${empty.length} groups hold`} nothing at all, so ${empty.length === 1 ? 'it' : 'they'} cannot be reviewed — there is no claim there to accept. The emit stays closed until ${empty.length === 1 ? 'it has' : 'they have'} something in ${empty.length === 1 ? 'it' : 'them'}.`),
      h('ul', { class: 'st-review-list' }, empty.map((entry) => h('li', { [KEY_ATTR]: entry.group },
        h('strong', null, humanize(entry.group)),
        ' — ',
        brandGroupEvidence(brand, entry.group).describe,
        '. ',
        emptyAdvice(entry.group))))))
    : null,
  starter.length
    ? notice('warn', h('div', null,
      h('p', null, `${starter.length === 1 ? 'One group is' : `${starter.length} groups are`} still exactly what a new project starts with. Nothing has been extracted from their site and nothing has been entered by hand, which is what the 0% reads — it is “not measured”, not “measured and bad”. The emit stays closed until you have looked at ${starter.length === 1 ? 'it' : 'them'}, and what is on screen is not theirs until you make it so.`),
      h('ul', { class: 'st-review-list' }, starter.map((entry) => h('li', { [KEY_ATTR]: entry.group },
        h('strong', null, humanize(entry.group)),
        ' — ',
        brandGroupEvidence(brand, entry.group).describe,
        ', as shipped. ',
        starterAdvice(entry.group))))))
    : null,
  measured.length
    ? notice('warn', h('div', null,
      h('p', null, `${measured.length === 1 ? 'One group is' : `${measured.length} groups are`} below the ${Math.round(LOW_CONFIDENCE * 100)}% confidence floor. The emit stays closed until each is reviewed.`),
      h('ul', { class: 'st-review-list' }, measured.map((entry) => h('li', { [KEY_ATTR]: entry.group },
        h('strong', null, humanize(entry.group)),
        ' — ',
        formatPercent(entry.confidence),
        ' confident, ',
        brandGroupEvidence(brand, entry.group).describe,
        '. ',
        reviewAdvice(entry.group))))))
    : null,
  reviewable.length
    ? h('div', { class: 'st-review-checks' }, reviewable.map((entry) => checkbox({
      label: `${humanize(entry.group)} checked`,
      act: 'brand.review',
      arg: entry.group,
      checked: false,
      hint: brandGroupIsStarterDefault(brand, entry.group)
        ? 'Marks this group reviewed. These are still the studio’s starting values, so ticking this accepts them as the brand the artifact will wear.'
        : 'Marks this group reviewed. Editing a field does not review it — looking at it does.',
    })))
    : null);
}

/**
 * What to do about a group that is still the shipped starting value. Distinct
 * from `reviewAdvice`, which tells you how to check a *measurement*: there is
 * no measurement here and no source to check one against.
 * @param {string} group
 * @returns {string}
 */
function starterAdvice(group) {
  const advice = {
    colors: 'Extract their site above, or type their hexes into the roles below. Until then the artifact would wear PitchProof’s navy, not theirs.',
    faces: 'Extract their site above, or enter the families they actually use — the fallback stack is what decides whether headlines overflow.',
    logos: 'Ask them for the SVG, or drop it with the saved page.',
    shape: 'Set the radius, border and shadow from a real component on their site.',
    imagery: 'Choose the treatment that matches what they publish.',
  };
  return advice[group] || 'Extract their site above, or enter it by hand below.';
}

/** @param {string} group @returns {string} */
function emptyAdvice(group) {
  const advice = {
    colors: 'Extract again with the page’s stylesheet, or add the roles by hand below.',
    faces: 'Add the families they use by hand — the fallback stack is what decides whether headlines overflow.',
    logos: 'Ask them for the SVG, or drop it with the saved page.',
    shape: 'Set the radius, border and shadow from a real component on their site.',
    imagery: 'Choose the treatment that matches what they publish.',
  };
  return advice[group] || 'Enter it by hand below.';
}

/**
 * §6's strategy chain, in L3's own words. A fetch that returns only the
 * document — which is most of them — leaves nothing to extract a brand from, so
 * the way forward has to be on the page rather than in a support article.
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderStrategies(app) {
  const strategies = app.services.fetchStrategies();
  if (!strategies.length) return null;
  return h('details', { class: 'st-details' },
    h('summary', null, `How the studio gets a page · ${strategies.length} routes, tried in order`),
    h('ol', { class: 'st-strategies' }, strategies.map((strategy) => h('li', {
      class: cx('st-strategy', !strategy.automatic && 'st-strategy--manual'),
      [KEY_ATTR]: strategy.id,
    },
    h('span', { class: 'st-strategy-label' }, strategy.label),
    strategy.automatic ? badge('automatic', 'dim') : badge('you supply it', 'info'),
    h('span', { class: 'st-strategy-describe' }, strategy.describe)))));
}

/** @param {string} group @returns {string} */
function reviewAdvice(group) {
  const advice = {
    colors: 'Check the roles landed on the colours they actually use, and that every on-colour reads.',
    faces: 'Check the fallback is the face that will really render, and look at the metric delta.',
    logos: 'Check the mark is theirs, at the right variant, and that an inverse exists if a dark scene needs one.',
    shape: 'Check the radius and border against a real component on their site.',
    imagery: 'Check the treatment matches what they publish, not what the hero image happened to be.',
  };
  return advice[group] || 'Check it against the source before an emit relies on it.';
}

/**
 * @param {any} app
 * @param {any} brand
 */
function renderColors(app, brand) {
  const colors = brand.colors || [];
  const missing = COLOR_ROLES.filter((r) => !colors.some((c) => c.role === r));
  return section({
    title: 'Colour',
    subtitle: 'Contrast is computed against the designated pair, never assumed (§7).',
    actions: missing.length
      ? h('div', { class: 'st-inline-add' },
        h('select', {
          class: 'st-input st-select st-input--compact',
          [ACT_ATTR]: 'brand.addColor', 'aria-label': 'Add a colour role',
          [KEY_ATTR]: 'brand-add-color',
        },
        h('option', { value: '', selected: true }, 'Add a role…'),
        missing.map((r) => h('option', { value: r }, r))))
      : null,
  },
  colors.length
    ? h('table', { class: 'st-table st-table--colors' },
      h('thead', null, h('tr', null,
        h('th', null, 'Role'),
        h('th', null, 'Swatch'),
        h('th', null, 'Hex'),
        h('th', null, 'Pair'),
        h('th', null, 'Contrast'),
        h('th', null, 'Source'),
        h('th', null, ''))),
      h('tbody', null, colors.map((token) => renderColorRow(app, brand, token))))
    : empty('No colour roles yet. Extract a site, or add the roles by hand.'),
  h('p', { class: 'st-note' }, `Every foreground role (${FOREGROUND_ROLES.join(', ')}) must reach ${CONTRAST_AA_BODY}:1 against its pair. Below that, the rehearsal sweep raises CONTRAST_FAIL at severity 1 and the emit is closed.`));
}

/**
 * @param {any} app
 * @param {any} brand
 * @param {any} token
 */
function renderColorRow(app, brand, token) {
  const pairRole = pairedRole(token.role);
  const pairToken = pairRole ? (brand.colors || []).find((c) => c.role === pairRole) : null;
  const live = pairToken ? app.services.contrast(token.hex, pairToken.hex) : null;
  const ratio = live === null ? token.contrastWithPair : live;
  const isForeground = FOREGROUND_ROLES.includes(token.role);
  const fails = isForeground && typeof ratio === 'number' && ratio < CONTRAST_AA_BODY;
  return h('tr', { class: cx('st-tr', fails && 'st-tr--bad'), [KEY_ATTR]: token.role },
    h('td', { class: 'st-mono' }, token.role),
    h('td', null, swatch(token.hex, pairToken ? pairToken.hex : '#000000', token.role.slice(0, 2))),
    h('td', null, h('input', {
      class: 'st-input st-input--hex st-mono',
      type: 'text',
      value: token.hex,
      'aria-label': `${token.role} hex`,
      [ACT_ATTR]: 'brand.setColor',
      [ARG_ATTR]: token.role,
      [KEY_ATTR]: `hex-${token.role}`,
    })),
    h('td', { class: 'st-mono st-dim' }, pairRole || '—'),
    h('td', { class: cx('st-mono', fails && 'st-bad') },
      formatRatio(ratio),
      fails ? badge('below 4.5', 'bad') : null),
    h('td', null, badge(token.source, token.source === 'manual' ? 'info' : token.source === 'derived' ? 'warn' : 'dim')),
    h('td', { class: 'st-tr-actions' },
      isForeground
        ? button({ act: 'brand.deriveOnColor', arg: token.role, variant: 'ghost', title: 'Walk lightness in OKLCH until this reaches 4.5:1' }, 'Derive')
        : null,
      button({ act: 'brand.removeColor', arg: token.role, variant: 'quiet', title: `Remove ${token.role}` }, '×')));
}

/**
 * @param {any} app
 * @param {any} brand
 */
function renderFaces(app, brand) {
  const faces = brand.faces || [];
  return section({
    title: 'Type',
    subtitle: 'The fallback is what will actually render. The delta is what predicts the overflow.',
    actions: toolbar(button({ act: 'brand.addFace', variant: 'ghost' }, 'Add a face')),
  },
  faces.length
    ? h('div', { class: 'st-faces' }, faces.map((face, i) => h('div', { class: 'st-face', [KEY_ATTR]: `face-${i}` },
      h('div', { class: 'st-face-head' },
        field({
          label: 'Family', act: 'brand.setFaceFamily', arg: String(i), value: face.family,
          placeholder: 'Inter', key: `face-family-${i}`,
        }),
        select({
          label: 'Role', act: 'brand.setFaceRole', arg: String(i), value: face.role,
          options: [
            { value: 'display', label: 'Display' },
            { value: 'body', label: 'Body' },
            { value: 'mono', label: 'Mono' },
          ],
          key: `face-role-${i}`,
        }),
        button({ act: 'brand.removeFace', arg: String(i), variant: 'quiet', title: 'Remove this face' }, '×')),
      field({
        label: 'Fallback stack', act: 'brand.setFaceStack', arg: String(i), mono: true,
        value: (face.fallbackStack || []).join(', '),
        key: `face-stack-${i}`,
        hint: `Resolves to ${resolvedFace(face)} on a machine without the licensed file.`,
      }),
      pairs(
        pair('Weights seen', h('span', { class: 'st-mono' }, (face.weightsSeen || []).join(', ') || '—')),
        pair('Cap height', h('span', { class: 'st-mono' }, formatMetric(face.metricDelta ? face.metricDelta.capHeight : null))),
        pair('x-height', h('span', { class: 'st-mono' }, formatMetric(face.metricDelta ? face.metricDelta.xHeight : null))),
        pair('Average advance', h('span', {
          class: cx('st-mono', face.metricDelta && Math.abs(face.metricDelta.avgAdvance - 1) > 0.06 ? 'st-warn' : null),
        }, formatMetric(face.metricDelta ? face.metricDelta.avgAdvance : null))),
      ),
      face.metricDelta && Math.abs(face.metricDelta.avgAdvance - 1) > 0.06
        ? notice('warn', `The fallback runs ${formatPercent(Math.abs(face.metricDelta.avgAdvance - 1), 1)} ${face.metricDelta.avgAdvance > 1 ? 'wider' : 'narrower'} than ${face.family || 'the requested face'}. That is the gap that overflows headlines after substitution — the sweep measures against the fallback, so run it before you rely on any layout.`)
        : null,
      // Three dashes with no explanation read as a failed measurement. The
      // delta is measured when a face is captured from a page; a face typed in
      // by hand has never been compared against anything.
      face.metricDelta
        ? null
        : h('p', { class: 'st-field-hint' }, 'No delta yet: it is measured when a face is read off a real page, by comparing that face against the fallback that would replace it. Extract their site to have it filled in — the rehearsal sweep measures overflow against the fallback either way.'),
      renderFaceLicence(app, face, i))))
    : empty('No faces detected yet.', button({ act: 'brand.addFace', variant: 'primary' }, 'Add one by hand')));
}

/**
 * The licence, which is the file.
 *
 * §7: "`embeddable` is false unless the user explicitly supplies a font file
 * they assert they have rights to." What stood here was a checkbox that set the
 * flag on its own — CRITIQUE-2 C3 — so the two FONT_UNAVAILABLE warnings
 * vanished, the emit opened, and the artifact went out with no `@font-face` and
 * the family still at the head of its stack: the client's machine rendered
 * Arial while the studio claimed the face was embedded.
 *
 * There is no checkbox now. Choosing the file *is* the assertion, it is recorded
 * against the operator's name and L5's clock, and removing the file withdraws
 * the assertion in the same act — so the claim and the fact cannot move apart.
 * @param {any} app
 * @param {any} face
 * @param {number} i
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderFaceLicence(app, face, i) {
  const file = face.fontFile && typeof face.fontFile.dataUri === 'string' && face.fontFile.dataUri.startsWith('data:')
    ? face.fontFile
    : null;
  const assertion = face.rightsAssertion || null;

  if (face.embeddable && file) {
    return h('div', { class: 'st-face-licence' },
      pairs(
        pair('Embedded file', h('span', { class: 'st-mono' }, file.fileName || 'the supplied file')),
        pair('Size', h('span', { class: 'st-mono' }, formatBytes(fontBytes(file)))),
        pair('Licence asserted by', assertion ? assertion.assertedBy : '—'),
        pair('Asserted', assertion && assertion.assertedAt ? formatDateTime(assertion.assertedAt) : '—'),
      ),
      h('p', { class: 'st-field-hint' }, `The artifact carries this file as an @font-face rule, so ${face.family} renders on a machine that has never had it installed — and it counts against the emit's byte budget like any other asset.`),
      toolbar(button({
        act: 'brand.detachFont', arg: String(i), variant: 'quiet',
        title: 'Remove the file and withdraw the assertion',
      }, 'Remove the font file')));
  }

  if (face.embeddable && !file) {
    // Nothing in this build can produce this state; a project saved by an older
    // one can, and an imported .pitchproof.json can carry it from anywhere.
    return h('div', { class: 'st-face-licence' },
      notice('warn', `${face.family || 'This face'} is marked embeddable but carries no file, so the artifact would substitute ${resolvedFace(face)} while the sweep stayed quiet about it. Attach the licensed file, or withdraw the claim.`),
      toolbar(button({ act: 'brand.detachFont', arg: String(i), variant: 'ghost' }, 'Withdraw the claim')));
  }

  return h('label', { class: 'st-field st-face-licence' },
    h('span', { class: 'st-field-label' }, 'Attach the licensed font file'),
    h('input', {
      class: 'st-input st-file', type: 'file', accept: FONT_ACCEPT,
      [ACT_ATTR]: 'brand.attachFont', [ARG_ATTR]: String(i), [KEY_ATTR]: `face-font-${i}`,
      'aria-label': `Attach a licensed font file for ${face.family || 'this face'}`,
    }),
    h('span', { class: 'st-field-hint' }, app.ui.settings.operator
      ? `.woff2, .woff, .ttf or .otf. Choosing a file asserts, in your name (${app.ui.settings.operator}), that you have the right to embed it in a file you hand a client — §7 is why nothing is ever fetched from a foundry on your behalf. Until one is attached, the artifact renders ${resolvedFace(face)} instead.`
      : `.woff2, .woff, .ttf or .otf. Put your name in Settings first: choosing a file asserts a licence, and §7 records who asserted it. Until one is attached, the artifact renders ${resolvedFace(face)} instead.`));
}

/** @param {any} file @returns {number} */
function fontBytes(file) {
  if (typeof file.bytes === 'number' && file.bytes > 0) return file.bytes;
  // A data: URI's base64 payload, decoded: 3 bytes for every 4 characters.
  const base64 = String(file.dataUri || '').split(',')[1] || '';
  const padding = (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** @param {any} face @returns {string} */
function resolvedFace(face) {
  const stack = face.fallbackStack || [];
  return stack.length ? stack[stack.length > 1 ? 1 : 0] : 'the system default';
}

/**
 * @param {any} app
 * @param {any} brand
 */
function renderLogos(app, brand) {
  const logos = brand.logos || [];
  return section({
    title: 'Logo',
    subtitle: 'Inline SVG first, then the icon, then og:image, then the largest raster in the header (§7).',
  },
  logos.length
    ? h('div', { class: 'st-logos' }, logos.map((logo) => h('div', { class: 'st-logo', [KEY_ATTR]: logo.id },
      h('div', { class: cx('st-logo-art', logo.variant === 'inverse' && 'st-logo-art--inverse') },
        logo.kind === 'svg' ? rawBox(logo.data, 'st-logo-svg') : h('img', {
          class: 'st-logo-img', src: logo.data, alt: `${logo.variant} logo`,
        })),
      h('div', { class: 'st-logo-meta' },
        select({
          label: 'Variant', act: 'brand.setLogoVariant', arg: logo.id, value: logo.variant,
          options: ['primary', 'mark', 'wordmark', 'inverse', 'favicon'].map((v) => ({ value: v, label: v })),
          key: `logo-variant-${logo.id}`,
        }),
        pairs(
          pair('Intrinsic', h('span', { class: 'st-mono' }, `${logo.intrinsic.w}×${logo.intrinsic.h}`)),
          pair('Transparency', logo.hasTransparency ? badge('yes', 'ok') : badge('no', 'warn')),
          pair('Kind', h('span', { class: 'st-mono' }, logo.kind)),
        ),
        toolbar(
          button({ act: 'brand.deriveInverse', arg: logo.id, variant: 'ghost', title: 'Only possible when the mark is monochrome' }, 'Derive inverse'),
          button({ act: 'brand.removeLogo', arg: logo.id, variant: 'quiet' }, 'Remove'))))))
    : empty('No logo captured. Extraction picks one up from the page; otherwise drop the SVG they sent you.'),
  logos.length && !logos.some((l) => l.variant === 'inverse')
    ? notice('warn', 'There is no inverse variant. A dark full-bleed scene will need one, and an automatic inversion is only safe on a monochrome mark — ask them for the real asset.')
    : null);
}

/**
 * @param {any} app
 * @param {any} brand
 */
function renderShapeAndImagery(app, brand) {
  return section({
    title: 'Shape and imagery',
    subtitle: 'The modal radius, the modal border, the shadow tier, and how they photograph.',
  },
  h('div', { class: 'st-grid-2' },
    field({
      label: 'Corner radius (px)', act: 'brand.setRadius', type: 'number',
      value: String(brand.shape.radiusPx), key: 'brand-radius',
    }),
    field({
      label: 'Border width (px)', act: 'brand.setBorderWidth', type: 'number',
      value: String(brand.shape.borderWidthPx), key: 'brand-border',
    })),
  h('div', { class: 'st-field', role: 'group', 'aria-label': 'Shadow level' },
    h('span', { class: 'st-field-label' }, 'Shadow level'),
    h('div', { class: 'st-segmented' }, [0, 1, 2, 3].map((level) => button({
      act: 'brand.setShadow', arg: String(level), className: 'st-segment',
      variant: brand.shape.shadowLevel === level ? 'primary' : 'ghost',
      pressed: brand.shape.shadowLevel === level ? 'true' : 'false',
    }, String(level))))),
  h('div', { class: 'st-grid-2' },
    select({
      label: 'Imagery treatment', act: 'brand.setImageryTreatment', value: brand.imagery.treatment,
      options: ['photographic', 'illustrative', 'mixed', 'unknown'].map((v) => ({ value: v, label: v })),
      key: 'brand-imagery',
    }),
    field({
      label: 'Saturation bias', act: 'brand.setSaturationBias', type: 'number',
      value: String(brand.imagery.saturationBias), key: 'brand-saturation',
      hint: '−1 desaturated, +1 saturated.',
    })));
}

/**
 * @param {any} app
 * @param {any} brand
 * @param {Set<string>} reviewed
 */
function renderConfidence(app, brand, reviewed) {
  return section({
    title: 'Confidence and review',
    subtitle: 'Computed from cluster separation, sample size and agreement across sources — never hardcoded (§7).',
  },
  // Five bars reading 0% look like a broken extractor. On a project where no
  // extraction has been attempted they mean the opposite: nothing has been
  // measured, so there is nothing for a confidence to be about yet.
  brandIsUntouched(brand)
    ? notice('info', 'Nothing has been extracted or entered yet, so every group reads 0%. That is “not measured”, not “measured and found wrong” — extract their site above, or fill the fields in by hand.')
    : null,
  h('div', { class: 'st-conf' }, BRAND_GROUPS.map((group) => {
    const value = Number(brand.confidence?.[group] ?? 0);
    const low = value < LOW_CONFIDENCE;
    const isReviewed = reviewed.has(group);
    const evidence = brandGroupEvidence(brand, group);
    return h('div', { class: cx('st-conf-row', low && !isReviewed && 'st-conf-row--pending'), [KEY_ATTR]: group },
      h('span', { class: 'st-conf-name' }, humanize(group)),
      h('span', { class: 'st-conf-bar' }, h('span', {
        class: cx('st-conf-fill', low ? 'st-conf-fill--low' : 'st-conf-fill--ok'),
        style: { width: `${Math.max(2, Math.min(100, value * 100)).toFixed(1)}%` },
      })),
      h('span', { class: 'st-conf-value st-mono' }, formatPercent(value)),
      low
        ? checkbox({
          label: 'Reviewed',
          act: 'brand.review',
          arg: group,
          checked: isReviewed,
          disabled: !evidence.hasContent && !isReviewed,
          hint: !evidence.hasContent
            ? `Nothing to review — ${evidence.describe}.`
            : brandGroupIsStarterDefault(brand, group)
              ? 'Not measured — this is still the value a new project starts with.'
              : null,
        })
        : badge('above the floor', 'ok'));
  })));
}

/**
 * @param {any} brand
 */
function renderOverrides(brand) {
  const overrides = brand.manualOverrides || [];
  return section({
    title: 'Manual overrides',
    subtitle: 'Every field you changed by hand, recorded by path (§4 `manualOverrides`).',
  },
  overrides.length
    ? h('ul', { class: 'st-paths' }, overrides.map((path) => h('li', { class: 'st-mono', [KEY_ATTR]: path }, path)))
    : empty(brand.sourceUrl
      ? 'Nothing has been overridden. Everything here is as extracted.'
      : 'Nothing has been overridden — and nothing has been extracted either, so everything above is the value a new project starts with.'));
}

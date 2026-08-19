/**
 * CRITIQUE-2's studio findings, each guarded by the thing that would have
 * caught it.
 *
 * All three were invisible to a green suite, and for the same reason: the tests
 * checked what the studio *computed* and never what it *passed on*. The adapter
 * was called, the panels rendered, the emitter emitted — and the two arguments
 * that carry the brand into the file were simply absent from the call.
 *
 *   - **C7** — the emit passed no `themeCss`, so every artifact fell through to
 *     L10's `compileFallbackTheme`, the path named for a build where L5 has not
 *     landed. The preview compiled the same brand through L5. Nineteen of
 *     twenty-three custom properties agreed; the stage padding, the transition
 *     duration and the shadow did not.
 *   - **C3** — the emit passed no `fonts`, no action accepted a font file, and
 *     the one control that existed set `embeddable` on its own: both
 *     FONT_UNAVAILABLE warnings vanished, the emit opened, and the artifact
 *     shipped with the prospect's family at the head of its stack and no
 *     embedded face behind it. §18 exists to prevent exactly that.
 *   - **C6** — `studio.lastProject` was written only when a project was opened
 *     or imported, so the first reload after creating one opened an empty
 *     studio.
 *
 * So the assertions here are about the seam rather than the parts: what the
 * preview installs and what the emit passes must be the same string; a face is
 * embeddable only when a file is behind it, checked across the whole registry;
 * and a save is what makes a project the one that reopens.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StudioApp } from '../../src/ui/app.js';
import { ACTIONS, actionIndex, fakeFontInput } from '../../src/ui/actions.js';
import { makeServices, artifactFonts } from '../../src/ui/services.js';
import { unfoundedFontClaims } from '../../src/ui/model.js';
import { PANELS } from '../../src/ui/panels/index.js';
import { emitBlockers } from '../../src/ui/gate.js';
import { ProjectStore } from '../../src/core/storage.js';
import { SETTING_KEYS } from '../../src/ui/constants.js';
import { compileFallbackTheme } from '../../src/emit/theme.js';
import { buildRuntime } from '../../scripts/build.mjs';
import { makeProof } from '../fixtures/make-proof.mjs';
import { fixtureDoc, fakeServices, makeClock, finding } from '../fixtures/ui/studio-fixture.mjs';

const index = actionIndex(ACTIONS);

/** The bundled runtime, built once — the emitter refuses without it. */
let RUNTIME = null;
/** @returns {{js: string, css: string}} */
function runtime() {
  if (!RUNTIME) RUNTIME = buildRuntime();
  return RUNTIME;
}

/**
 * The studio's real adapter, on the real lanes.
 * @returns {any}
 */
function realServices() {
  const rt = runtime();
  const services = makeServices({ clock: makeClock(), runtimeJs: rt.js, runtimeCss: rt.css, http: null });
  services.ensureLayouts();
  return services;
}

/**
 * A studio on the fake adapter, with a fixture project in hand.
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function studio(options = {}) {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const app = new StudioApp({
    document: null, window: null, store, clock,
    services: fakeServices({ clock, ...options }), doc: fixtureDoc(),
  });
  app.ui.settings = { ...app.ui.settings, operator: 'Alex Mercer' };
  return app;
}

/** Every `--pp-*: value;` declaration in a stylesheet. @param {string} css @returns {Map<string,string>} */
function customProperties(css) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const m of String(css).matchAll(/(--pp-[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) out.set(m[1], m[2].trim());
  return out;
}

/**
 * Every string a viewer of a rendered tree could read.
 * @param {any} node
 * @param {string[]} [out]
 * @returns {string[]}
 */
function visibleStrings(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const c of node) visibleStrings(c, out); return out; }
  if (typeof node === 'string' || typeof node === 'number') {
    const s = String(node).trim();
    if (s) out.push(s);
    return out;
  }
  if (typeof node !== 'object') return out;
  if ('raw' in node) return out;
  for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
    const v = node.a ? node.a[attr] : null;
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  for (const c of node.c || []) visibleStrings(c, out);
  return out;
}

// --------------------------------------------------------------------- C7 ---

test('C7: the artifact wears the exact stylesheet the preview compiled', async () => {
  const services = realServices();
  const proof = makeProof();

  const previewCss = services.artifactThemeCss(proof.brand);
  assert.ok(previewCss.length > 0, 'L5 compiles a theme for this brand');

  const result = await services.emit(proof, proof.emitOptions);
  assert.ok(result.ok, result.ok ? '' : result.error);

  assert.ok(
    result.value.html.includes(previewCss),
    'the emitted document must carry the preview\'s stylesheet byte for byte, not a second compilation of the same brand',
  );
});

test('C7: every property the two compilers disagree about lands in the artifact the preview\'s way', async () => {
  const services = realServices();
  const proof = makeProof();

  const preview = customProperties(services.artifactThemeCss(proof.brand));
  const fallback = customProperties(compileFallbackTheme(proof.brand).css);

  // The four C7 measured, computed rather than pasted: whatever L5 says and
  // L10's stand-in does not. If the two ever converge the set is empty and the
  // byte-for-byte assertion above still holds.
  const disagree = [...preview].filter(([name, value]) => fallback.get(name) !== value);
  const html = (await services.emit(proof, proof.emitOptions)).value.html;
  const artifact = customProperties(html.slice(html.indexOf('--pp-')));

  for (const [name, value] of disagree) {
    assert.equal(
      artifact.get(name), value,
      `${name} must be what the preview showed (${value}), not what compileFallbackTheme substitutes (${fallback.get(name) || 'nothing at all'})`,
    );
  }
  for (const [name, value] of preview) {
    assert.equal(artifact.get(name), value, `${name} reached the artifact unchanged`);
  }
});

test('C7: one compile, reached from both sides through the adapter', () => {
  const services = realServices();
  const brand = makeProof().brand;
  assert.equal(
    services.artifactThemeCss(brand),
    services.compileTheme(brand).css,
    'the adapter\'s theme string is L5\'s, unedited',
  );
});

// --------------------------------------------------------------------- C3 ---

test('C3: the studio has a route that accepts a font file, and it embeds it', async () => {
  const app = await studio();
  const face = app.proof.brand.faces[0];
  assert.equal(face.embeddable, false, 'nothing is embeddable before a file arrives');

  await app.dispatch('brand.attachFont', '0', { element: fakeFontInput('Inter-Regular.woff2') });

  const after = app.proof.brand.faces[0];
  assert.equal(after.embeddable, true, '§7: supplying the file is what makes a face embeddable');
  assert.ok(after.fontFile && after.fontFile.dataUri.startsWith('data:font/woff2;base64,'), 'the file travels with the project');
  assert.equal(after.rightsAssertion.assertedBy, 'Alex Mercer', '§7 records who asserted the licence');
  assert.match(after.rightsAssertion.statement, /right to embed/i);
  assert.ok(after.rightsAssertion.assertedAt, 'and when, from the injected clock');

  const fonts = artifactFonts(app.proof.brand);
  assert.equal(fonts.length, 1, 'exactly the supplied face reaches the emitter');
  assert.equal(fonts[0].licenseAsserted, true, 'L10 embeds only what carries an assertion');
  assert.equal(fonts[0].dataUri, after.fontFile.dataUri);
});

test('C3: the supplied file reaches the emitted artifact', async () => {
  const services = realServices();
  const proof = makeProof();
  const dataUri = 'data:font/woff2;base64,d09GMgABAAAA';

  const attached = services.attachUserFont(proof.brand.faces, {
    family: proof.brand.faces[0].family,
    fileName: 'Northwind-Sans.woff2',
    dataUri,
    mime: 'font/woff2',
    weights: [400],
    rightsAssertion: { assertedBy: 'Alex Mercer', statement: 'Licensed for client deliverables.' },
  });
  assert.ok(attached.ok, attached.ok ? '' : attached.error);

  const withFont = { ...proof, brand: { ...proof.brand, faces: attached.value.faces } };
  const before = await services.emit(proof, proof.emitOptions);
  const after = await services.emit(withFont, withFont.emitOptions);
  assert.ok(before.ok && after.ok);

  assert.ok(!/@font-face/.test(before.value.html), 'nothing is embedded until a file is supplied');
  assert.ok(/@font-face/.test(after.value.html), 'the artifact carries the face the seller licensed');
  assert.ok(after.value.html.includes(dataUri), 'and the actual bytes, inline (§13)');
});

test('C3: no action in the registry can make a face embeddable without a file', async () => {
  // The category, not the incident. `brand.setFaceEmbeddable` was one checkbox;
  // what §7 requires is that *nothing* sets the flag except the route that
  // takes the file. Every mutating action is run against a project whose faces
  // carry no file, and any claim left standing afterwards fails here.
  const offenders = [];
  for (const action of index.mutating) {
    const app = await studio();
    const sample = action.sample(app) || {};
    // The one action whose sample deliberately seeds a file to remove.
    if (action.id === 'brand.detachFont') continue;
    const result = action.run(app, sample.arg === undefined ? null : sample.arg, {
      value: sample.value, element: sample.element || null, event: null,
    });
    if (result && typeof result.then === 'function') await result;
    for (const face of unfoundedFontClaims(app.proof.brand)) {
      offenders.push(`${action.id} left ${face.family} claiming a licence with no file`);
    }
  }
  assert.deepEqual(offenders, [], '§7: `embeddable` is false unless the user supplied a file');
});

test('C3: the assertion is refused when there is nobody to attribute it to', async () => {
  const app = await studio();
  app.ui.settings = { ...app.ui.settings, operator: '' };
  const before = structuredClone(app.doc);

  await app.dispatch('brand.attachFont', '0', { element: fakeFontInput('Inter-Regular.woff2') });

  assert.deepEqual(structuredClone(app.doc), before, 'nothing changed');
  const notice = app.ui.notices.at(-1);
  assert.match(notice.text, /name in Settings/i, 'and the studio says what is missing');
  assert.equal(app.proof.brand.faces[0].embeddable, false);
});

test('C3: a file that is not a font is refused rather than embedded', async () => {
  const app = await studio();
  await app.dispatch('brand.attachFont', '0', {
    element: { value: '', files: [{ name: 'brand-guidelines.pdf', type: 'application/pdf', arrayBuffer: async () => new Uint8Array([1, 2]).buffer }] },
  });
  assert.equal(app.proof.brand.faces[0].embeddable, false, 'a PDF is not a licence');
  assert.match(app.ui.notices.at(-1).text, /not a font file/i);
});

test('C3: removing the file withdraws the assertion with it', async () => {
  const app = await studio();
  await app.dispatch('brand.attachFont', '0', { element: fakeFontInput('Inter-Regular.woff2') });
  assert.equal(app.proof.brand.faces[0].embeddable, true);

  app.dispatch('brand.detachFont', '0');
  const face = app.proof.brand.faces[0];
  assert.equal(face.embeddable, false, 'the claim goes when the fact does');
  assert.equal(face.fontFile, null);
  assert.equal(face.rightsAssertion, null);
  assert.deepEqual(artifactFonts(app.proof.brand), [], 'and nothing is handed to the emitter');
});

test('C3: a record claiming a licence with no file has the claim cleared on open, out loud', async () => {
  const app = await studio();
  const doc = fixtureDoc();
  const faces = doc.proof.brand.faces.map((f, i) => (i === 0 ? { ...f, embeddable: true } : f));
  const record = {
    id: doc.id, name: doc.name, seed: doc.seed, savedAt: '2026-08-19T03:09:00.000Z', revision: 4,
    proof: { ...doc.proof, brand: { ...doc.proof.brand, faces } },
  };

  app.loadRecord(record);

  assert.deepEqual(unfoundedFontClaims(app.proof.brand), [], 'the claim did not survive the load');
  assert.equal(app.proof.brand.faces[0].embeddable, false);
  const notice = app.ui.notices.find((n) => /font licence/i.test(n.text));
  assert.ok(notice, 'a claim the studio withdrew on the user\'s behalf is announced, not silently corrected');
  assert.match(notice.text, /attach the licensed file/i, 'and the way to get the face back is named');
  assert.equal(notice.sticky, true);
});

test('C3: a face carrying a claim and no file is shown as exactly that, with the way out', async () => {
  // The state `loadRecord` corrects, rendered — because the model can hold it
  // (§4 does not couple the flag to the file; L11 reads the flag as availability)
  // and a panel that drew nothing here would leave the user with a face that is
  // silently substituted.
  const app = await studio();
  app.mutate('seed a claim with no file', (doc) => ({
    ...doc,
    proof: {
      ...doc.proof,
      brand: { ...doc.proof.brand, faces: doc.proof.brand.faces.map((f, i) => (i === 0 ? { ...f, embeddable: true } : f)) },
    },
  }), { scope: 'brand' });

  app.ui.section = 'brand';
  const text = visibleStrings(PANELS.brand(app)).join('\n');
  assert.match(text, /marked embeddable but carries no file/i, 'it names the discrepancy');
  assert.match(text, /would substitute/i, 'and what the client would actually see');
  assert.match(text, /Withdraw the claim/, 'and offers the withdrawal');
});

test('C3: a claim with no file behind it is never handed to the emitter', () => {
  const brand = { faces: [{ family: 'Ghost', role: 'body', embeddable: true, weightsSeen: [400] }] };
  assert.deepEqual(artifactFonts(brand), [], 'the flag alone embeds nothing');
});

// --------------------------------------------------------------------- C6 ---

/**
 * A studio sharing one store with another, which is what a reload is.
 * @param {any} store
 * @param {() => string} clock
 * @returns {any}
 */
function studioOn(store, clock) {
  return new StudioApp({
    document: null, window: null, store, clock,
    services: fakeServices({ clock }), doc: fixtureDoc(),
  });
}

test('C6: a project created and saved in this session is the one the studio reopens', async () => {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });

  const first = studioOn(store, clock);
  await first.dispatch('project.new');
  first.dispatch('project.setProspect', null, { value: 'Northwind Industrial' });
  first.dispatch('project.setName', null, { value: 'CRITIC PERSISTENCE TEST' });
  const saved = await first.saveNow();
  assert.ok(saved.ok, 'the save the seller pressed Ctrl+S for');

  assert.equal(
    await store.getSetting(SETTING_KEYS.lastProject, null),
    first.doc.id,
    'a save states which project is in hand — it was only ever stated by an open (C6)',
  );

  const reloaded = studioOn(store, clock);
  await reloaded.start();

  assert.equal(reloaded.doc.id, first.doc.id, 'the reload lands back in the project being built');
  assert.equal(reloaded.doc.name, 'CRITIC PERSISTENCE TEST');
  assert.equal(reloaded.proof.prospectName, 'Northwind Industrial');
});

test('C6: an autosaved edit is enough — the seller need not press Ctrl+S', async () => {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });

  const first = studioOn(store, clock);
  await first.dispatch('project.new');
  first.dispatch('project.setProspect', null, { value: 'Autosaved GmbH' });
  // No window, so `scheduleSave` writes immediately rather than on a timer.
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const reloaded = studioOn(store, clock);
  await reloaded.start();
  assert.equal(reloaded.doc.id, first.doc.id);
  assert.equal(reloaded.proof.prospectName, 'Autosaved GmbH');
});

test('C6: switching projects still moves what the reload opens', async () => {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });

  const app = studioOn(store, clock);
  await app.dispatch('project.new');
  app.dispatch('project.setName', null, { value: 'First' });
  await app.saveNow();
  const firstId = app.doc.id;

  await app.dispatch('project.duplicate');
  const copyId = app.doc.id;
  assert.notEqual(copyId, firstId);

  const reloaded = studioOn(store, clock);
  await reloaded.start();
  assert.equal(reloaded.doc.id, copyId, 'the last one written is the one that comes back');

  await app.dispatch('project.open', firstId);
  const again = studioOn(store, clock);
  await again.start();
  assert.equal(again.doc.id, firstId, 'and an open still states it too');
});

// -------------------------------------------------- C11, the other half -----

test('C11: “Nothing blocks the emit” is still printed when nothing does', async () => {
  // The vacuous cases are guarded in `empty-state-honesty.test.mjs`. This is the
  // other side of that guard: the sentence must survive where it is true, or the
  // finding has been "fixed" by deleting the reassurance the panel exists to
  // give.
  const app = await studio({ findings: [finding({ id: 'fd_ok', severity: 3, code: 'STALE_CAPTURE' })] });
  app.dispatch('brand.reviewAll');
  await app.dispatch('rehearse.sweep');

  const gate = emitBlockers(app);
  assert.equal(gate.canEmit, true, `the fixture project must reach an open gate: ${gate.blockers.map((b) => b.kind).join(', ')}`);

  app.ui.section = 'rehearse';
  const text = visibleStrings(PANELS.rehearse(app)).join('\n');
  assert.match(text, /Nothing blocks the emit\./, 'true, and said plainly');
  assert.doesNotMatch(text, /walked no scenes/i, 'this sweep walked the whole deck');
});

// --------------------------------------------------------------------- C8 ---
//
// C8 is L8's finding, but it moved a signal this lane was reading. A captured
// `<pre>` used to arrive as a `raw` block; it now arrives as
// `{type: 'paragraph', text, pre: true}` (API.md Part 3b), because there was
// never any captured markup in it — `rawTextOf` had already discarded every
// element — and `raw` made three of four realistic code samples severity-1
// emit blockers with the printed remedy "drop the raw block".
//
// So the two questions came apart: `raw` means *untrusted markup a layout must
// not present*, `pre` means *this text's whitespace carries meaning*. The block
// editor was asking the first to answer the second, and a parameter table now
// edits in a proportional face — the alignment that made it worth capturing
// invisible to the one person able to break it.
//
// Asserted against the rendered tree rather than the panel's source, for the
// reason `empty-state-honesty.test.mjs` gives: a class name in a comment, in a
// JSDoc block or in a string the panel never returns is not on screen.

/** The exact shape `src/specimen/blocks.js` now emits for a captured `<pre>`. */
const PRE_TEXT = 'param\tunits\tdefault\nfouling\tm²·K/W\t0.00018\nvelocity\tm/s\t1.20';

/**
 * Every VNode in a rendered tree that satisfies `match`, in render order.
 * @param {any} node
 * @param {(n: any) => boolean} match
 * @param {any[]} [out]
 * @returns {any[]}
 */
function findNodes(node, match, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const c of node) findNodes(c, match, out); return out; }
  if ('raw' in node) return out;
  if (match(node)) out.push(node);
  for (const c of node.c || []) findNodes(c, match, out);
  return out;
}

/**
 * The block editor drawn for block `index` of the selected specimen: the one
 * textarea wired to `specimen.setBlockText` for that position.
 * @param {any} tree
 * @param {string} specimenId
 * @param {number} index
 * @returns {any}
 */
function blockEditor(tree, specimenId, index) {
  const found = findNodes(tree, (n) => n.t === 'textarea'
    && n.a[ACT_ATTR] === 'specimen.setBlockText'
    && n.a[ARG_ATTR] === `${specimenId}:${index}`);
  assert.equal(found.length, 1, `exactly one editor for block ${index} of ${specimenId}`);
  return found[0];
}

/**
 * @param {any} node
 * @returns {string[]}
 */
function classes(node) {
  return String((node.a && node.a.class) || '').split(/\s+/).filter(Boolean);
}

/**
 * The specimens panel, with a preformatted paragraph, a raw block and a plain
 * paragraph all in one specimen so the three treatments can be told apart.
 * @returns {Promise<{app: any, tree: any, id: string}>}
 */
async function specimensWithPre() {
  const app = await studio();
  const specimen = app.proof.specimens[0];
  const id = specimen.id;
  specimen.blocks = [
    { type: 'paragraph', text: 'Forty years of protecting steel.' },
    { type: 'paragraph', text: PRE_TEXT, pre: true },
    { type: 'raw', html: '<p>markup the layout must not present</p>' },
  ];
  app.select({ specimenId: id });
  app.ui.section = 'specimens';
  return { app, tree: PANELS.specimens(app), id };
}

test('C8: a `pre: true` paragraph edits in a monospace face', async () => {
  const { tree, id } = await specimensWithPre();
  const editor = blockEditor(tree, id, 1);

  assert.equal(editor.a.value, PRE_TEXT, 'the editor really holds the preformatted text');
  assert.ok(
    classes(editor).includes('st-mono'),
    `a preformatted block must edit in the monospace face; got class "${editor.a.class}". `
    + 'Keying this on `block.type === "raw"` worked only while a captured <pre> arrived as a raw block.',
  );
  assert.ok(
    classes(editor).includes('st-block-text--pre'),
    'and must keep its columns rather than soft-wrapping them into prose',
  );
});

test('C8: `raw` and `pre` are answered as the two different questions they are', async () => {
  const { tree, id } = await specimensWithPre();

  const plain = blockEditor(tree, id, 0);
  const pre = blockEditor(tree, id, 1);
  const rawBlock = blockEditor(tree, id, 2);

  assert.ok(!classes(plain).includes('st-mono'), 'prose is prose');
  assert.ok(!classes(plain).includes('st-block-text--pre'));

  // `raw` still reads as markup source, which is a monospace job for its own
  // reason — but it is not whitespace-significant, so it still wraps.
  assert.ok(classes(rawBlock).includes('st-mono'), 'markup source is still read in a monospace face');
  assert.ok(!classes(rawBlock).includes('st-block-text--pre'), 'markup is not whitespace-significant');

  // The preformatted block is a `paragraph`. If anything still reached for
  // `type === 'raw'` to mean "preformatted", this is where it would show.
  assert.equal(pre.a[ARG_ATTR], `${id}:1`);
  assert.match(String(pre.a['aria-label']), /^preformatted paragraph block 2$/,
    'and it announces itself as preformatted, since the reason the face changed is not visible to a screen reader');
});

test('C8: a preformatted editor is sized in lines, not in wrapped characters', async () => {
  const { tree, id } = await specimensWithPre();
  const pre = blockEditor(tree, id, 1);
  // Three lines of a parameter table: 71 characters, which the prose estimate
  // would have drawn at the two-row floor.
  assert.equal(Number(pre.a.rows), 3, 'a three-line table gets three rows');
});

test('C8: nothing else in the studio reads `raw` to mean “preformatted”', async () => {
  const { app } = await specimensWithPre();
  // The other question `raw` answers — may a layout present this markup? — is
  // per-specimen and unchanged, so the opt-in must still be off and still be
  // offered on a specimen whose blocks include a preformatted paragraph.
  assert.equal(rawOptIn(app.proof.specimens[0]).allowed, false);

  for (const section of Object.keys(PANELS)) {
    app.ui.section = section;
    const tree = PANELS[section](app);
    const monos = findNodes(tree, (n) => classes(n).includes('st-block-text--pre'));
    for (const node of monos) {
      assert.equal(node.t, 'textarea', `${section}: the preformatted treatment belongs to an editor`);
    }
    // Rendering every panel with a `pre` block in hand must not throw.
    assert.ok(tree, `${section} rendered`);
  }
});

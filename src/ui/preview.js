/**
 * The live preview (§15: "centre canvas with live preview at true aspect").
 *
 * The preview is not a second renderer. It is `Runtime` + `RuntimeHost` — the
 * same two classes the emitted artifact boots — mounted into a frame the studio
 * owns. §12 requires the studio preview and the artifact to agree; the only way
 * to guarantee that rather than promise it is to run the same code, so this
 * module contains no rendering of its own at all.
 *
 * It mounts into a same-document frame written directly by the parent, the way
 * `runtime/presenter.js` writes the presenter window (D16). That buys the one
 * thing §15 demands and a scoped stylesheet cannot honestly give: the artifact's
 * CSS — `html`, `body`, `:root` and all — applies to the preview and to nothing
 * else, so the studio's `--st-*` chrome and the artifact's `--pp-*` theme can
 * never bleed into one another. It also makes "true aspect" literal: the frame
 * is exactly the breakpoint's pixel size and is scaled to fit, so what is on
 * screen is the artifact at a known width, not an approximation of it.
 *
 * When the host has no usable frame (a test harness, a very old browser) the
 * preview degrades to mounting the same runtime into a plain element. The deck
 * still renders and the keyboard still works; only the artifact stylesheet is
 * absent, and `degraded` says so out loud.
 *
 * @module ui/preview
 */

import { Runtime } from '../runtime/runtime.js';
import { RuntimeHost, STAGE_ROOT_ID } from '../runtime/host.js';
import { contentHash } from '../core/hash.js';
import { BREAKPOINTS } from '../core/contracts.js';

/** The frame's own reset — the artifact stylesheet supplies everything else. */
const FRAME_SHELL_CSS = 'html,body{margin:0;padding:0;height:100%;overflow:hidden}';

/**
 * @typedef {object} PreviewEnv
 * @property {Document} document
 * @property {any} window
 * @property {string} runtimeCss    the bundled artifact stylesheet
 * @property {any} services
 */

/**
 * A mounted preview.
 */
export class Preview {
  /** @param {PreviewEnv} env */
  constructor(env) {
    this.doc = env.document;
    this.win = env.window;
    this.runtimeCss = env.runtimeCss || '';
    this.services = env.services;

    /** @type {Element|null} */
    this.host = null;
    /** @type {any} */
    this.frame = null;
    /** @type {Document|null} */
    this.frameDoc = null;
    /** @type {Element|null} */
    this.stage = null;
    /** @type {Runtime|null} */
    this.runtime = null;
    /** @type {RuntimeHost|null} */
    this.hostBinding = null;
    /** @type {(() => void)|null} */
    this.overlayCleanup = null;

    this.breakpoint = 'lg';
    this.themeCss = '';
    this.fingerprint = '';
    this.themeFingerprint = '';
    this.scale = 1;
    /** @type {string|null} set when the frame could not be used */
    this.degraded = null;
    /** @type {((reason: string) => void)|null} */
    this.onChange = null;
    /** @type {any} */
    this.resizeObserver = null;
    /** @type {(() => void)|null} */
    this.detachResize = null;
  }

  /**
   * Take over an element. Idempotent: mounting into the same host twice is a
   * no-op, which matters because the studio re-renders around this element on
   * every keystroke.
   * @param {Element} host
   */
  attach(host) {
    if (this.host === host && this.frame) return this;
    this.detach();
    this.host = host;
    this.buildFrame();
    this.watchResize();
    return this;
  }

  /** Build the frame (or the degraded element) inside the host. */
  buildFrame() {
    const host = this.host;
    if (!host || !this.doc.createElement) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const frame = this.doc.createElement('iframe');
    frame.setAttribute('title', 'Proof preview');
    frame.setAttribute('class', 'st-preview-frame');
    // No `src`: the document is written by the parent, so there is nothing to
    // load and nothing for a network scanner to forgive.
    host.appendChild(frame);

    const frameDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
    if (!frameDoc || typeof frameDoc.write !== 'function') {
      host.removeChild(frame);
      const fallback = this.doc.createElement('div');
      fallback.setAttribute('class', 'st-preview-fallback');
      const stage = this.doc.createElement('div');
      stage.setAttribute('id', STAGE_ROOT_ID);
      fallback.appendChild(stage);
      host.appendChild(fallback);
      this.frame = fallback;
      this.frameDoc = this.doc;
      this.stage = stage;
      this.degraded = 'This browser would not give the preview its own document, so the preview is running without the artifact stylesheet. The emitted file is unaffected.';
      return;
    }

    this.frame = frame;
    this.frameDoc = frameDoc;
    this.degraded = null;
    this.writeFrameDocument();
  }

  /** Write the frame's document: reset, artifact stylesheet, theme, stage. */
  writeFrameDocument() {
    const doc = this.frameDoc;
    if (!doc || doc === this.doc) return;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><title>Proof preview</title></head><body></body></html>');
    doc.close();
    const head = doc.head || doc.getElementsByTagName('head')[0];
    const base = doc.createElement('style');
    base.textContent = FRAME_SHELL_CSS;
    head.appendChild(base);
    const runtimeStyle = doc.createElement('style');
    runtimeStyle.setAttribute('data-pp-style', 'runtime');
    runtimeStyle.textContent = this.runtimeCss;
    head.appendChild(runtimeStyle);
    const themeStyle = doc.createElement('style');
    themeStyle.setAttribute('data-pp-style', 'theme');
    themeStyle.textContent = this.themeCss;
    head.appendChild(themeStyle);
    this.themeStyle = themeStyle;
    const stage = doc.createElement('div');
    stage.setAttribute('id', STAGE_ROOT_ID);
    doc.body.appendChild(stage);
    this.stage = stage;
  }

  /**
   * Point the preview at a proof. Rebuilds the runtime only when the deck
   * actually changed, so typing a headline re-renders rather than re-boots and
   * the presenter's position in the deck survives an edit.
   * @param {object} args
   * @param {import('../core/contracts.d.ts').Proof} args.proof
   * @param {string} [args.breakpoint]
   * @param {string|null} [args.sceneId]     scene to show, when the studio has a selection
   * @param {'presenter'|'review'} [args.mode]
   */
  update({ proof, breakpoint, sceneId, mode }) {
    if (!this.stage) return;
    if (breakpoint && breakpoint !== this.breakpoint) { this.breakpoint = breakpoint; this.fit(); }

    this.services.ensureLayouts();

    const theme = this.services.compileTheme(proof.brand);
    const themeCss = theme && theme.css ? theme.css : '';
    if (themeCss !== this.themeCss) {
      this.themeCss = themeCss;
      if (this.themeStyle) this.themeStyle.textContent = themeCss;
    }

    const fingerprint = deckFingerprint(proof);
    if (!this.runtime || fingerprint !== this.fingerprint) {
      this.rebuild(proof, mode);
      this.fingerprint = fingerprint;
    } else {
      // Same deck shape, changed content: swap the model under the runtime and
      // repaint. Rebuilding here would throw the presenter back to scene one on
      // every keystroke, which is the §20.10 "loses work" failure in miniature.
      this.runtime.proof = proof;
      this.runtime.deck.proof = proof;
      this.reindex(proof);
      if (this.hostBinding) this.hostBinding.paint();
    }

    if (sceneId && this.runtime && this.runtime.deck.sceneById.has(sceneId)) {
      const current = this.runtime.scene;
      if (!current || current.id !== sceneId) this.runtime.go({ type: 'goToScene', sceneId });
    }
  }

  /**
   * Rebuild the runtime for a proof, preserving the position where it can.
   * @param {import('../core/contracts.d.ts').Proof} proof
   * @param {'presenter'|'review'} [mode]
   */
  rebuild(proof, mode) {
    const keep = this.runtime ? { sceneId: this.runtime.scene ? this.runtime.scene.id : null, beat: this.runtime.nav.beatIndex } : null;
    this.teardownRuntime();
    if (!(proof.spine || []).length) {
      // Nothing to stage yet. Leave the stage empty rather than booting a
      // runtime with no scenes; the canvas renders its own empty state.
      if (this.stage) while (this.stage.firstChild) this.stage.removeChild(this.stage.firstChild);
      return;
    }
    const runtime = new Runtime(proof, {
      mode: mode || 'presenter',
      reducedMotion: this.prefersReducedMotion(),
      presenterAvailable: true,
    });
    this.overlayCleanup = this.services.registerBranchOverlays(runtime);
    const frameWin = this.frame && this.frame.contentWindow ? this.frame.contentWindow : this.win;
    this.hostBinding = new RuntimeHost(runtime, {
      document: /** @type {Document} */ (this.frameDoc),
      window: frameWin,
      root: this.stage,
    }).attach();
    this.runtime = runtime;
    runtime.on('change', (e) => { if (this.onChange) this.onChange(e && e.reason ? e.reason : 'change'); });
    if (keep && keep.sceneId && runtime.deck.sceneById.has(keep.sceneId)) {
      runtime.go({ type: 'goToScene', sceneId: keep.sceneId });
      for (let i = 0; i < keep.beat; i++) runtime.go({ type: 'nextBeat' });
    }
  }

  /**
   * Refresh the runtime's specimen/rendition/media indexes after a content edit
   * that did not change the deck's shape.
   * @param {import('../core/contracts.d.ts').Proof} proof
   */
  reindex(proof) {
    const runtime = this.runtime;
    if (!runtime) return;
    runtime.specimenById = new Map((proof.specimens || []).map((s) => [s.id, s]));
    runtime.renditionById = new Map((proof.renditions || []).map((r) => [r.id, r]));
    const media = new Map();
    for (const s of proof.specimens || []) for (const m of s.media || []) media.set(m.id, m);
    for (const r of proof.renditions || []) for (const m of r.media || []) media.set(m.id, m);
    runtime.mediaById = media;
    runtime.labelIllustrative = proof.emitOptions ? proof.emitOptions.labelIllustrativeContent !== false : true;
    // The deck holds the scene objects the layouts read, so it has to be
    // rebuilt from the edited proof or the preview would show stale text.
    for (const [id, scene] of sceneIndex(proof)) runtime.deck.sceneById.set(id, scene);
    const spine = runtime.deck.sequences.get('spine');
    if (spine) spine.scenes = proof.spine || [];
    for (const branch of proof.branches || []) {
      const seq = runtime.deck.sequences.get(branch.id);
      if (seq) { seq.scenes = branch.scenes || []; seq.objection = branch.objection; seq.aliases = branch.aliases || []; }
    }
  }

  /** @returns {boolean} */
  prefersReducedMotion() {
    const view = this.win;
    return !!(view && view.matchMedia && view.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /**
   * Drive the preview from the studio's keyboard, for the actions that belong
   * to the deck rather than to the editor.
   * @param {string} command
   * @param {any} [payload]
   * @returns {boolean}
   */
  run(command, payload) {
    if (!this.runtime) return false;
    return this.runtime.run(command, payload);
  }

  /** Move focus into the preview so the artifact's own keyboard model takes over. */
  focus() {
    if (this.frame && typeof this.frame.focus === 'function') { this.frame.focus(); return true; }
    return false;
  }

  /** Size the frame to the breakpoint and scale it to fit the host. */
  fit() {
    const host = this.host;
    const frame = this.frame;
    if (!host || !frame || !frame.style) return;
    const bp = BREAKPOINTS.find((b) => b.id === this.breakpoint) || BREAKPOINTS[BREAKPOINTS.length - 1];
    const box = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : { width: 0, height: 0 };
    const available = { w: Math.max(0, box.width), h: Math.max(0, box.height) };
    frame.style.width = `${bp.width}px`;
    frame.style.height = `${bp.height}px`;
    frame.style.border = '0';
    frame.style.transformOrigin = 'top left';
    if (!available.w || !available.h) { this.scale = 1; frame.style.transform = ''; return; }
    const scale = Math.min(available.w / bp.width, available.h / bp.height);
    this.scale = scale;
    frame.style.transform = `scale(${scale.toFixed(4)})`;
    frame.style.marginLeft = `${Math.max(0, (available.w - bp.width * scale) / 2).toFixed(1)}px`;
    frame.style.marginTop = `${Math.max(0, (available.h - bp.height * scale) / 2).toFixed(1)}px`;
  }

  /** Keep the fit correct as the studio window changes shape. */
  watchResize() {
    const view = this.win;
    if (view && typeof view.ResizeObserver === 'function' && this.host) {
      this.resizeObserver = new view.ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.host);
    }
    if (view && typeof view.addEventListener === 'function') {
      const onResize = () => this.fit();
      view.addEventListener('resize', onResize);
      this.detachResize = () => view.removeEventListener('resize', onResize);
    }
    this.fit();
  }

  /** Drop the runtime and its host binding. */
  teardownRuntime() {
    if (this.overlayCleanup) { try { this.overlayCleanup(); } catch { /* already gone */ } this.overlayCleanup = null; }
    if (this.hostBinding) { this.hostBinding.detach(); this.hostBinding = null; }
    if (this.runtime) { this.runtime.clear(); this.runtime = null; }
  }

  /** Release everything. */
  detach() {
    this.teardownRuntime();
    if (this.resizeObserver) { try { this.resizeObserver.disconnect(); } catch { /* fine */ } this.resizeObserver = null; }
    if (this.detachResize) { this.detachResize(); this.detachResize = null; }
    if (this.host) { while (this.host.firstChild) this.host.removeChild(this.host.firstChild); }
    this.host = null;
    this.frame = null;
    this.frameDoc = null;
    this.stage = null;
    this.themeStyle = null;
    this.fingerprint = '';
  }
}

/**
 * A digest of everything the deck's *shape* depends on. Content changes (a
 * headline, a block's text) deliberately do not appear here, so editing text
 * does not reboot the runtime.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {string}
 */
export function deckFingerprint(proof) {
  return contentHash({
    spine: (proof.spine || []).map(sceneShape),
    branches: (proof.branches || []).map((b) => ({
      id: b.id, returnPolicy: b.returnPolicy, scenes: (b.scenes || []).map(sceneShape),
    })),
  });
}

/** @param {import('../core/contracts.d.ts').Scene} scene */
function sceneShape(scene) {
  return {
    id: scene.id,
    layout: scene.layout,
    specimenId: scene.specimenId,
    renditionIds: scene.renditionIds || [],
    beats: (scene.beats || []).map((b) => ({ id: b.id, reveals: b.reveals || [] })),
    branchAnchors: scene.branchAnchors || [],
  };
}

/**
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {[string, import('../core/contracts.d.ts').Scene][]}
 */
function sceneIndex(proof) {
  const out = [];
  for (const s of proof.spine || []) out.push([s.id, s]);
  for (const b of proof.branches || []) for (const s of b.scenes || []) out.push([s.id, s]);
  return out;
}

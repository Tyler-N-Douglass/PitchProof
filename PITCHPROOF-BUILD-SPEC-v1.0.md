# PitchProof — BUILD SPEC v1.0
### A pitch proof generator: compile a prospect's own content and brand into a self-contained, offline, branchable proof.

**Repo slug:** `pitchproof`
**Target runtime:** Browser. No server. No build step required to run the studio.
**Authoring model:** Claude Code, Opus 5, parallel subagent fan-out, `/loop` until the adversarial critic passes clean twice consecutively.

---

## §1. PRODUCT DEFINITION

PitchProof is a **studio** that compiles a **proof artifact**.

- The **studio** is a single-file, Netlify-deployable HTML application used by a seller/solution lead before a pitch.
- The **proof artifact** is a separate single-file HTML document, fully self-contained, that opens with no network, no login, and no dependencies, and is presented live in a client meeting or forwarded to stakeholders afterward.

The studio ingests a prospect's public web presence and supplied materials, extracts their brand system, captures real content specimens, stages before/after scenes against those specimens, wires objection branches, validates the whole thing in rehearsal, and emits the artifact.

**The core thesis the build must serve:** a generic demo dies to the objection *"our situation is different."* A proof built on the prospect's own content and brand removes the surface that objection lands on.

### §1.1 Non-goals — do not build these

1. **No engagement telemetry, view tracking, analytics, pixels, or phone-home of any kind** in the emitted artifact. This is a hard product law, not a preference. The artifact must be verifiably inert on the network.
2. **No live generation during presentation.** The artifact contains only pre-baked content.
3. **No CMS, DAM, or platform integrations.** Ingest is public web plus local files.
4. **No forecasting, scoring, ROI calculators, or measurement dashboards.** PitchProof produces and presents; it does not estimate.
5. **No account system, no cloud sync, no backend.**

### §1.2 Definition of done

A user can, in one sitting: paste a prospect URL, get an extracted brand system and a specimen library, assemble a scene sequence from the scenario library, attach at least three objection branches, run rehearsal to a clean pass, emit a single `.html` file, open that file on a machine with networking disabled, present it start to finish with keyboard navigation, jump to any branch and return to the spine, and hand the same file to someone else who can open it cold.

---

## §2. OPERATING MODES

| Mode | Surface | Purpose |
|---|---|---|
| **Build** | Studio | Ingest, extract, curate specimens, stage scenes, wire branches |
| **Rehearse** | Studio | Automated preflight + manual dry run with issue list |
| **Present** | Artifact | Full-screen, keyboard-driven, presenter notes on a second screen |
| **Review** | Artifact | Self-paced mode for a forwarded recipient — no presenter notes, adds a contents index |

The artifact must detect its own context: opened by a presenter (keyboard/remote navigation, presenter view available) vs opened by a recipient (Review mode default). Presenter view is toggled explicitly, never assumed.

---

## §3. DOMAIN MODEL

Concepts, in dependency order:

- **BrandSystem** — extracted or hand-entered visual identity: color roles, type stack, logo assets, imagery treatment, shape language.
- **Specimen** — a real piece of the prospect's content, captured and typed (page, article, product detail, campaign asset, PDF excerpt, image).
- **Recipe** — a named transformation applied to a specimen to produce a Rendition (e.g. "localize to 9 markets", "assemble from design system components", "generate channel variants").
- **Rendition** — the output side of a before/after pair. Always carries provenance.
- **Beat** — the smallest presentable unit: one visual state with optional reveal steps.
- **Scene** — an ordered set of beats sharing a layout and a point.
- **Spine** — the ordered sequence of scenes that forms the main narrative.
- **Branch** — an off-spine scene sequence attached to a named objection, reachable by jump, always returning to its anchor.
- **Proof** — the compiled whole: brand system, specimens, scenes, spine, branches, assets, presenter notes.

---

## §4. FROZEN CONTRACTS

These TypeScript interfaces are **frozen**. Lanes may extend with optional fields only; no lane may rename, retype, or remove a field. Any lane that believes a contract is wrong must record the objection in `CONTRACTS-DISPUTES.md` and proceed against the contract as written.

```ts
// ---------- Brand ----------
export type ColorRole =
  | 'primary' | 'onPrimary' | 'secondary' | 'onSecondary'
  | 'surface' | 'onSurface' | 'surfaceAlt' | 'onSurfaceAlt'
  | 'accent' | 'onAccent' | 'border' | 'success' | 'warning' | 'danger';

export interface ColorToken {
  role: ColorRole;
  hex: string;                 // #RRGGBB
  oklch: [number, number, number]; // L 0..1, C, H degrees
  source: 'extracted' | 'derived' | 'manual';
  /** Contrast ratio against its designated pair, computed, never assumed. */
  contrastWithPair: number | null;
}

export interface TypeFace {
  family: string;
  fallbackStack: string[];     // metric-compatible ordering
  weightsSeen: number[];
  role: 'display' | 'body' | 'mono';
  /** Ratio of this face's cap-height/x-height to the chosen fallback. */
  metricDelta: { capHeight: number; xHeight: number; avgAdvance: number } | null;
  embeddable: boolean;         // true only if a license-clear webfont file was supplied by the user
}

export interface LogoAsset {
  id: string;
  kind: 'svg' | 'raster';
  data: string;                // inline SVG markup or data URI
  variant: 'primary' | 'mark' | 'wordmark' | 'inverse' | 'favicon';
  intrinsic: { w: number; h: number };
  hasTransparency: boolean;
}

export interface BrandSystem {
  id: string;
  sourceUrl: string | null;
  capturedAt: string;          // ISO
  colors: ColorToken[];
  faces: TypeFace[];
  logos: LogoAsset[];
  shape: { radiusPx: number; borderWidthPx: number; shadowLevel: 0|1|2|3 };
  imagery: { treatment: 'photographic'|'illustrative'|'mixed'|'unknown'; saturationBias: number; };
  confidence: Record<'colors'|'faces'|'logos'|'shape'|'imagery', number>; // 0..1
  manualOverrides: string[];   // field paths the user edited
}

// ---------- Content ----------
export type SpecimenKind =
  | 'page' | 'article' | 'product' | 'campaign' | 'document' | 'image' | 'fragment';

export interface Specimen {
  id: string;
  kind: SpecimenKind;
  title: string;
  sourceUrl: string | null;
  capturedAt: string;
  /** Normalized semantic tree; chrome/nav/footer stripped. */
  blocks: ContentBlock[];
  media: MediaRef[];
  meta: Record<string, string>;   // title, description, canonical, lang, og:*
  wordCount: number;
  locale: string | null;
}

export type ContentBlock =
  | { type: 'heading'; level: 1|2|3|4|5|6; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string; attribution?: string }
  | { type: 'table'; rows: string[][]; header: boolean }
  | { type: 'cta'; label: string; href: string | null }
  | { type: 'media'; ref: string; caption?: string }
  | { type: 'raw'; html: string };

export interface MediaRef {
  id: string;
  dataUri: string;             // always inlined by emit time
  alt: string | null;
  intrinsic: { w: number; h: number };
  bytes: number;
}

// ---------- Transformation ----------
export type Provenance = 'client-supplied' | 'illustrative' | 'verified-by-user';

export interface Rendition {
  id: string;
  specimenId: string;
  recipeId: string;
  label: string;               // e.g. "de-DE", "Email variant", "PDP module"
  blocks: ContentBlock[];
  media: MediaRef[];
  provenance: Provenance;      // NEVER default to 'verified-by-user'
  producedBy: 'manual-paste' | 'adapter' | 'template';
  notes: string | null;
}

export interface Recipe {
  id: string;
  name: string;
  intent: string;              // one line: what a viewer should conclude
  inputKinds: SpecimenKind[];
  outputLabels: string[];      // expected rendition labels
  adapterPrompt: string | null; // used only if an adapter is configured at runtime
}

// ---------- Presentation ----------
export type SceneLayout =
  | 'splitBeforeAfter' | 'fanOut' | 'stack' | 'fullBleed'
  | 'sideNote' | 'systemMap' | 'quoteCard' | 'contentsIndex';

export interface Beat {
  id: string;
  /** Element ids revealed at this beat, additive over the scene. */
  reveals: string[];
  presenterNote: string | null;
  dwellHintMs: number | null;  // presentation pacing hint only; never auto-advances
}

export interface Scene {
  id: string;
  layout: SceneLayout;
  headline: string | null;
  subhead: string | null;
  specimenId: string | null;
  renditionIds: string[];
  beats: Beat[];
  branchAnchors: string[];     // Branch ids offerable from this scene
}

export interface Branch {
  id: string;
  objection: string;           // verbatim phrasing a client would use
  aliases: string[];           // other phrasings, for the jump search
  scenes: Scene[];
  returnPolicy: 'anchor' | 'nextSpineScene';
}

export interface Proof {
  schemaVersion: 1;
  id: string;
  prospectName: string;
  createdAt: string;
  brand: BrandSystem;
  specimens: Specimen[];
  renditions: Rendition[];
  recipes: Recipe[];
  spine: Scene[];
  branches: Branch[];
  emitOptions: EmitOptions;
}

export interface EmitOptions {
  mode: 'presenter' | 'review' | 'both';
  includePresenterNotes: boolean;
  maxBytes: number;            // default 25_000_000
  imageQuality: 0.6 | 0.75 | 0.85 | 0.92;
  labelIllustrativeContent: boolean; // default true, user may not disable in Review builds
}

// ---------- Validation ----------
export interface Finding {
  id: string;
  severity: 1 | 2 | 3;         // 1 blocks emit, 2 warns, 3 informational
  code: FindingCode;
  message: string;
  locus: { sceneId?: string; branchId?: string; specimenId?: string; assetId?: string };
  autoFixAvailable: boolean;
}

export type FindingCode =
  | 'ASSET_MISSING' | 'ASSET_OVERSIZE' | 'FONT_UNAVAILABLE' | 'TEXT_OVERFLOW'
  | 'CONTRAST_FAIL' | 'BRANCH_UNREACHABLE' | 'BRANCH_NO_RETURN' | 'BEAT_EMPTY'
  | 'PROVENANCE_UNLABELED' | 'NETWORK_REFERENCE' | 'STALE_CAPTURE'
  | 'SPECIMEN_EMPTY' | 'DUPLICATE_SCENE' | 'SIZE_BUDGET_EXCEEDED';
```

---

## §5. ARCHITECTURE

Three artifacts come out of this repo:

1. `dist/pitchproof-studio.html` — the studio. Single file, Netlify-deployable, no build server needed. Inline CSS/JS. IndexedDB for project storage.
2. `dist/pitchproof-runtime.js` (embedded, not shipped separately) — the presentation runtime that gets inlined into every emitted proof.
3. Emitted `*.pitchproof.html` files — the deliverable artifacts.

**Source layout** (authored as modules, bundled to single files by a small esbuild script committed in-repo):

```
/src
  /ingest        fetch strategies, HTML normalization, file import
  /brand         color science, type detection, logo extraction, theme compile
  /specimen      DOM → ContentBlock[], chrome stripping, media capture
  /recipe        recipe library, adapters, rendition assembly
  /scene         scene model, layouts, beat engine
  /branch        branch graph, jump index, return logic
  /runtime       presentation runtime (shared by studio preview and artifact)
  /emit          inliner, asset budgeting, single-file writer
  /validate      preflight rules engine
  /ui            studio shell, panels, inspector
  /core          contracts, ids, storage, deterministic utilities
/test
  /fixtures      captured sites, synthetic defect corpora, reference values
/scripts         build.mjs, verify-offline.mjs
/dist
```

**Determinism law:** every id is generated from a seeded PRNG (PCG32, named substreams per subsystem) or content hash — never `Math.random()`, never `Date.now()` inside model construction. The same project must emit a byte-identical artifact twice. A test asserts this.

---

## §6. INGEST

Ingest must degrade gracefully and never dead-end. Strategies, tried in order, each independently useful:

1. **Direct fetch** of the URL. Will frequently fail on CORS. Handle failure silently and move on — do not surface a scary error as the primary experience.
2. **User-supplied CORS proxy** — a single settings field where the user pastes a proxy base URL they trust. Empty by default. Never ship a hardcoded third-party proxy.
3. **Saved-page import** — user saves the page from their browser and drops the `.html` and its asset folder, or a `.har` file, or a `.mhtml`.
4. **Paste HTML** — raw source pasted into a text area.
5. **File import** — `.docx`, `.pptx`, `.pdf`, images. Parse OOXML directly for text and embedded media; extract PDF text and page rasters.
6. **Manual entry** — brand fields and content blocks typed by hand.

**Sitemap assist:** when a fetch strategy works, offer `/sitemap.xml` and `/robots.txt` discovery to suggest high-value specimen candidates (home, a product/PDP, an article, a locale variant). Rank suggestions by structural richness, not by position.

**Capture hygiene:** record `capturedAt` on everything and raise `STALE_CAPTURE` at severity 3 when a specimen is older than 30 days at emit time.

---

## §7. BRAND EXTRACTION

This is the engine shared with STAMP. Build it clean and self-contained under `/src/brand`.

**Color.** Collect colors from computed styles where available, otherwise from the raw CSS and from a quantization pass over the hero imagery and logo. Convert sRGB → linear → OKLab. Cluster in OKLab (k-means, seeded init, k chosen by silhouette over k∈[3,8]). Weight clusters by rendered area, not by occurrence count — a color used once across a full-bleed hero matters more than a border used two hundred times.

**Role assignment is a solve, not a guess.** Given the cluster set, assign `ColorRole`s by optimizing a cost function over: contrast ratio against intended pairings (WCAG 2.1 relative luminance, computed exactly), chroma (accents want it, surfaces don't), lightness ordering, and hue distance between primary and accent. Every `onX` role must reach **≥ 4.5:1** against its pair; if no extracted color satisfies it, derive one by walking lightness in OKLCH while holding hue and clamping chroma, and mark it `source: 'derived'`.

**Type.** Detect families from `@font-face` rules, inline styles, and Google Fonts links. For each, select a metric-compatible fallback stack and compute `metricDelta` against the fallback using an offscreen canvas measurement of cap-height, x-height, and average advance width. `embeddable` is **false** unless the user explicitly supplies a font file they assert they have rights to — never fetch and embed a foundry's webfont into an artifact you're going to hand a client.

**Logo.** Prefer inline SVG, then `<link rel=icon>` SVG, then og:image, then the largest raster in the header region. Detect transparency. Auto-generate an inverse variant by luminance inversion only when the logo is monochrome; otherwise flag that a proper inverse asset is needed.

**Shape and imagery.** Modal border-radius, modal border width, shadow presence tier, and an imagery treatment classifier (edge density + saturation distribution + face detection heuristic → photographic / illustrative / mixed).

**Confidence, always.** Every extracted group carries a 0..1 confidence. The studio surfaces low-confidence fields for review before they can be used in an emit. Confidence is computed from cluster separation, sample size, and agreement across sources — never hardcoded.

---

## §8. SPECIMEN CAPTURE

Normalize a page into `ContentBlock[]`:

- Strip chrome by structural heuristics: repeated-across-pages detection when multiple pages are available, plus landmark roles, plus link-density ratio per block (nav blocks are link-dense and text-poor).
- Preserve heading hierarchy and repair skipped levels only with an explicit, reversible flag.
- Inline all media as data URIs at capture time, downscaled to a max edge of 2400px, recompressed at the project's `imageQuality`.
- Preserve `lang` and locale hints; they drive locale scenarios later.
- Keep an untouched `raw` copy of the source HTML per specimen for fallback rendering, but never present raw HTML in a scene without a user opt-in per specimen.

---

## §9. RECIPES, ADAPTERS, AND PROVENANCE

**Default adapter is manual.** The studio's assumption is that the user brings real outputs — produced in Gradial, produced by their own agent, or written by hand — and pastes or imports them as renditions. This path must be excellent, not a fallback: a side-by-side paste surface with block-level alignment to the source specimen.

**Optional runtime adapter.** A settings panel where the user can configure a generation endpoint and key at runtime. Rules: the key lives in memory and IndexedDB on their machine only; it is **never** written into an emitted artifact; the emitter must assert its absence; and every adapter-produced rendition is stamped `provenance: 'illustrative'` until the user explicitly promotes it.

**Provenance law.** Any rendition not marked `client-supplied` or explicitly promoted to `verified-by-user` renders with a visible, non-removable label in the artifact when `labelIllustrativeContent` is true — and it is true by default and cannot be disabled for Review-mode builds. The tool must never help someone imply that generated sample content is client-approved fact. Enforce this in the emitter, not just in the UI.

**Seed recipe library** (these are the reframe payload — build all of them):

1. `locale-fanout` — one source page, nine market renditions with locale-appropriate structure, not just translated strings.
2. `channel-variants` — page → email, paid social, in-product message, SMS, with per-channel length budgets enforced and visible.
3. `system-assembly` — show the same content assembled from design-system components at three breakpoints.
4. `brief-to-asset` — a one-paragraph brief becoming a structured, on-brand asset.
5. `governed-iteration` — the same asset iterated five times with brand and claim rules holding across all five.
6. `approval-chain` — the same asset shown at each review state with what each reviewer actually sees and touches.
7. `dam-round-trip` — asset sourced, variant produced, metadata written back.
8. `volume-view` — 1 → 40 → 400 renditions as a density visual, to make scale physical rather than asserted.

---

## §10. SCENE MODEL AND BEATS

Layouts are a closed set (§4). Each layout is a pure function of `(Scene, BrandSystem, Specimen, Rendition[])` → DOM. No layout may fetch, measure-and-reflow in a loop, or depend on animation timing for correctness.

**Beats are additive reveals.** Beat *n* shows everything from beats 0..*n*. Backward navigation is exact — going back one beat must restore the precise prior visual state, including scroll and any transform. This is tested with a state-hash assertion.

**No auto-advance ever.** `dwellHintMs` informs the presenter view only. A proof that moves on its own in front of a client is a defect.

**Motion budget.** Transitions ≤ 240ms, `prefers-reduced-motion` honored, and every animation must be interruptible without leaving a partial state.

---

## §11. BRANCH GRAPH

The spine is linear. Branches hang off it.

- Each branch declares the **objection in the client's words** plus aliases.
- A **jump index** is built at emit: fuzzy search over objection text and aliases, opened with a single key (`/`), navigable by arrow keys, reachable from any scene. The presenter types three characters of "approvals" and lands in the approval-chain branch in under a second.
- **Return is guaranteed.** Every branch exits to its anchor scene or the next spine scene per `returnPolicy`, and the runtime maintains a return stack so nested jumps unwind correctly.
- **Coverage rule:** validation raises `BRANCH_UNREACHABLE` for any branch with no anchor and no jump-index entry, and `BRANCH_NO_RETURN` for any branch whose last scene lacks a resolved return target.
- A **branch map** overlay (one key) shows the presenter where they are, what's been shown, and what's still available — because knowing what you haven't shown yet is the difference between closing cleanly and rambling.

---

## §12. PRESENTATION RUNTIME

Keyboard-first: `→`/`space` next beat, `←` previous beat, `↓`/`↑` scene, `/` jump index, `m` branch map, `b` blank screen, `r` return to spine, `p` presenter view, `Esc` exit overlays, `Home` first scene.

**Presenter view** opens in a second window: current beat, next beat preview, presenter note, branch availability, and a manual timer the presenter starts — never an automatic countdown.

**Blank screen** is a real requirement: one key to a neutral brand-colored screen for when the room needs to talk without a slide competing for attention.

**Cold-boot budget:** first meaningful paint under 1.5s from a local file on a mid-range laptop, and the runtime must be fully functional with networking disabled. `verify-offline.mjs` enforces this in CI by loading the emitted artifact in a headless browser with all network requests blocked and failing the build on any request attempt.

---

## §13. EMITTER

The emitter produces one `.html` file.

- Inline everything: CSS, JS, fonts (only user-supplied, license-asserted), images as data URIs, SVG as markup.
- **Zero network references.** Scan the final output for `http://`, `https://`, `//`, `src=`, `@import`, and fetch/XHR/WebSocket constructors outside of inert string literals. Any hit is `NETWORK_REFERENCE`, severity 1, emit blocked. This is how the no-telemetry law becomes verifiable rather than promised.
- **Size budgeting.** Greedy allocation against `maxBytes`: compute the byte cost of every asset, rank by presentation importance (spine before branch, revealed-early before revealed-late), and downscale progressively until under budget. Report exactly what was degraded and by how much — never silently.
- **Compression.** Consider deflate-compressing the payload and inflating at runtime via `DecompressionStream` with a raw-bytes fallback path; measure and keep whichever is smaller and still passes cold-boot budget.
- Emitted file opens correctly from `file://`, from a USB stick, and from an email attachment saved to a desktop.

---

## §14. REHEARSAL AND PREFLIGHT

Rehearsal is a first-class mode, not a lint pass.

**Automated sweep** walks every scene, every beat, and every branch in a headless pass and collects `Finding[]`:

- `TEXT_OVERFLOW` — measure rendered text against its container at all three breakpoints after the brand's type substitution has been applied. This is the highest-value check in the entire tool: font swap is what breaks reskinned layouts, and it breaks silently.
- `CONTRAST_FAIL` — every text/background pair, computed, at severity 1 for body text below 4.5:1.
- `ASSET_MISSING` / `ASSET_OVERSIZE` / `FONT_UNAVAILABLE`
- `BRANCH_UNREACHABLE` / `BRANCH_NO_RETURN` / `BEAT_EMPTY` / `DUPLICATE_SCENE`
- `PROVENANCE_UNLABELED` — severity 1.
- `NETWORK_REFERENCE` — severity 1.
- `STALE_CAPTURE`, `SPECIMEN_EMPTY`, `SIZE_BUDGET_EXCEEDED`

**Auto-fix** where safe and reversible: derive a compliant color, downscale an asset, trim a beat with no reveals, generate a missing return target. Every auto-fix is logged and undoable.

**Dry-run mode** puts the presenter through the full deck with a heads-up issue counter, so the last pass before walking in is a real rehearsal that also validates.

Severity 1 findings block emit. There is no override flag. If a lane proposes one, the critic rejects it.

---

## §15. STUDIO UI

Business-facing palette, carried from the Agentic Readiness Analyzer for family consistency:

- `#0B1220` ground, `#3B2EEA` primary, `#8B93F4` secondary, `#F0728C` signal
- Geist for interface, Geist Mono for numerals, ids, and code

Layout: left rail (project → brand → specimens → recipes → scenes → branches → rehearse → emit), center canvas with live preview at true aspect, right inspector for the selected object. Every panel is keyboard-reachable. Undo/redo across all model mutations with a command stack — required, not optional, because scene assembly is destructive editing under time pressure.

**The artifact never wears this palette.** The artifact wears the prospect's brand. Keep the two theming systems strictly separate; a single shared CSS variable between studio chrome and artifact output is a bug.

---

## §16. PERSISTENCE

- Projects in IndexedDB, autosaved on every committed mutation, with a versioned schema and a migration path from `schemaVersion: 1` forward.
- Export/import a project as a single `.pitchproof.json` (assets base64 inline) so a project moves between machines and can be committed to a repo.
- Storage-pressure handling: warn at 80% of estimated quota, offer asset re-compression, never fail a save silently.

---

## §17. VALIDATION AND TEST STRATEGY

Golden tests with objective ground truth wherever ground truth exists:

1. **Color science** — sRGB↔OKLab↔OKLCH round-trips against published reference values, tolerance 1e-6. WCAG contrast ratios against the W3C worked examples. Non-negotiable exactness; this math silently poisons everything downstream if it's off.
2. **Contrast solving** — for a corpus of adversarial brand palettes (near-white primaries, neon accents, monochrome), assert every emitted `onX` role meets 4.5:1.
3. **Type metrics** — measured cap-height/x-height ratios against a fixture set of known font pairs.
4. **Overflow detection** — a synthetic corpus with planted overflow at known locations; measure precision and recall; assert recall ≥ 0.98 for severity-1 overflow. Planted-defect corpora are the only honest way to know a detector works.
5. **Chrome stripping** — fixture pages with hand-labeled content regions; assert block-level F1 ≥ 0.9.
6. **Determinism** — same project emits byte-identical output twice; different seeds produce different ids but identical rendering.
7. **Offline integrity** — headless load with network blocked; zero requests attempted; full keyboard walk of every scene and branch completes.
8. **Return-stack correctness** — property test: random walks of jumps and returns always terminate on the spine, never on an orphan.
9. **Beat reversibility** — state hash after forward-then-back equals the original hash for every beat in every scene.
10. **Size budgeting** — assert degradation is monotonic in importance rank and that the reported degradation matches actual bytes saved.

---

## §18. HONESTY LAWS

Build these as enforced code paths, not documentation:

1. Illustrative content is always labeled in the artifact and the label cannot be styled to invisibility (contrast and size floors enforced at emit).
2. No fabricated metrics, logos of third parties, testimonials, or named customers may be inserted by the tool. There is no "sample stat" generator. Ever.
3. The prospect's own content is presented unmodified on the "before" side. If a specimen was edited, the artifact says so.
4. No tracking, no beacons, no network. Verified at emit, not asserted in a README.
5. Nothing in the emitted artifact claims a capability was performed live.

---

## §19. SUBAGENT LANES

Twelve lanes. Lanes 1–2 land first and unblock everything; the rest fan out in parallel.

| Lane | Scope | Depends on |
|---|---|---|
| **L1 Core** | Contracts, ids/PRNG, storage, command stack, build script | — |
| **L2 Runtime skeleton** | Scene host, beat engine, keyboard model, overlay system | L1 |
| **L3 Ingest** | Fetch strategies, HAR/MHTML/saved-page, OOXML + PDF import, sitemap assist | L1 |
| **L4 Brand: color** | OKLab pipeline, clustering, role solving, derivation, confidence | L1 |
| **L5 Brand: type/logo/shape** | Face detection, metric-compatible fallback, logo extraction, shape+imagery classifiers | L1 |
| **L6 Specimen** | Chrome stripping, block normalization, media inlining, locale detection | L1, L3 |
| **L7 Recipes** | Recipe library, manual paste alignment surface, optional adapter, provenance stamping | L1, L6 |
| **L8 Scenes** | All eight layouts, reveal system, motion budget, reduced-motion | L2, L4, L5 |
| **L9 Branches** | Branch graph, jump index + fuzzy search, return stack, branch map overlay | L2, L8 |
| **L10 Emitter** | Inliner, size budgeting, compression, network-reference scanner | L1, L8, L9 |
| **L11 Validate** | Rules engine, all finding codes, overflow measurement, auto-fix, dry-run mode | L8, L9, L10 |
| **L12 Studio UI** | Shell, rail, inspector, live preview, undo/redo wiring, storage pressure | L1–L11 |

Each lane owns its directory, writes its own tests, and may not edit another lane's files. Cross-lane needs go through the frozen contracts. A lane that finishes early picks up the next unclaimed lane rather than expanding its own scope.

---

## §20. ADVERSARIAL CRITIC RUBRIC

After every full pass, a critic subagent evaluates against these axes and writes `CRITIQUE-<n>.md` with specific file/line findings. Each axis is pass/fail with evidence; no numeric hand-waving.

1. **Contract fidelity** — no silent contract drift, disputes filed properly.
2. **Determinism** — no unseeded randomness, no wall-clock in model construction, byte-identical re-emit proven.
3. **Color correctness** — reference-value tests present and passing; no eyeballed constants.
4. **Offline integrity** — the network scanner actually catches planted violations; critic plants one and confirms the build fails.
5. **Overflow detection efficacy** — measured against the planted corpus, not asserted.
6. **Branch integrity** — property tests exist; critic attempts to construct an orphan and confirms validation catches it.
7. **Provenance enforcement** — critic attempts to emit unlabeled illustrative content and confirms it is blocked at the emitter, not merely hidden in the UI.
8. **Presentation robustness** — critic drives a full keyboard walk including nested jumps, blank screen, back-navigation from every beat, and reports any state corruption.
9. **Degradation honesty** — size budgeting reports match reality; no silent quality loss.
10. **Studio usability under pressure** — critic assembles a proof from a fixture site end to end and reports every place the flow stalls, requires a mouse where a key would do, or loses work.
11. **Non-goal violations** — any telemetry, any forecasting/scoring feature, any live-generation-at-present-time path, any backend dependency: automatic fail.

**The critic must actually build and present a proof end to end from the fixture corpus before writing its report.** A critique written without running the artifact is rejected and re-run.

---

## §21. `/loop` PROTOCOL

1. Fan out lanes per §19.
2. Integrate. Run the full test suite plus `verify-offline.mjs`.
3. Run the critic (§20).
4. Fix every severity-1 and every failed axis. Severity-2 findings are fixed unless a written rationale is filed in `DEFERRED.md`.
5. Repeat from step 2.
6. **Exit condition: the critic passes clean on all eleven axes twice consecutively, with the second pass run against a freshly emitted artifact.**

---

## §22. THE SIX THINGS MOST LIKELY TO BE WRONG

Attend to these first; they are where this build fails if it fails:

1. **Contrast role solving** — naive palette swapping produces unreadable proofs on real brands. The solve must be a real optimization with derived fallbacks, and it must be tested against hostile palettes.
2. **Text overflow after font substitution** — the defect that makes a proof look amateur in front of a CMO, and it is invisible until it isn't. Measurement must happen post-substitution, at every breakpoint.
3. **Chrome stripping on real sites** — enterprise sites are hostile: nested nav, cookie banners, personalization shells. Under-stripping poisons every specimen downstream.
4. **The return stack** — nested branch jumps that don't unwind correctly strand the presenter mid-pitch. Property-test it.
5. **Size budget vs cold-boot** — a 60MB artifact that takes eleven seconds to open is a failed artifact. Budget aggressively and prove the boot time.
6. **Provenance leakage** — the single reputational risk in this product is a proof that implies generated sample content is the client's approved copy. Enforce at the emitter.

---

## §23. EXECUTION DIRECTIVE

Apply maximum effort. Think the architecture through completely before writing code, and think each lane through completely before writing its files. The target is a complete, working product on the first pass — not a scaffold, not a demo of a demo generator, not a set of TODOs. Every function specified here is implemented, tested, and integrated.

Execute fully autonomously. Ask no clarifying questions. Insert no approval gates. At every decision point not settled by this spec, make the strongest decision in service of the stated product thesis and proceed, recording the decision and its rationale in `DECISIONS.md`. Ambiguity is resolved by building the better option, not by pausing.

Deliver a product that meets or exceeds this specification on the first pass.

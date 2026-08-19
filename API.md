# API — the integration surface

This document is **frozen** at the L1+L2 boundary and **binding** for the lane
surfaces below. It is the only thing lanes may assume about each other, together
with the §4 contracts in `src/core/contracts.d.ts`.

Two rules make parallel fan-out work:

1. **A lane imports only from `src/core/**`, `src/runtime/**`, and the lane
   surfaces declared here.** It never reaches into another lane's internals.
2. **A lane exports exactly the surface declared here**, from the module path
   declared here, with the signature declared here. Adding exports is fine;
   changing or omitting a declared one breaks integration.

If a declared surface looks wrong, file the objection in
`CONTRACTS-DISPUTES.md` and build it as declared anyway.

---

## Part 1 — L1 Core (landed, frozen)

### `src/core/contracts.js`

```js
COLOR_ROLES: ColorRole[]
ROLE_PAIR: Record<ColorRole, ColorRole|null>
FOREGROUND_ROLES: ColorRole[]        // onPrimary, onSecondary, onSurface, onSurfaceAlt, onAccent
BACKGROUND_ROLES: ColorRole[]
CONTRAST_AA_BODY = 4.5
CONTRAST_AA_LARGE = 3.0
CONTRAST_AA_NONTEXT = 3.0
SPECIMEN_KINDS, SCENE_LAYOUTS, PROVENANCE_VALUES, PROVENANCE_REQUIRING_LABEL,
BLOCK_TYPES, FINDING_CODES: string[]
FIXED_SEVERITY: Record<string, 1|2|3>   // severities no lane may lower
BREAKPOINTS: {id: 'sm'|'md'|'lg', width: number, height: number}[]   // 390 / 1024 / 1600
MAX_TRANSITION_MS = 240
QUALITY_STEPS = [0.6, 0.75, 0.85, 0.92]

defaultEmitOptions(): EmitOptions
normalizeEmitOptions(options): EmitOptions   // forces labelIllustrativeContent for review-reachable builds
validateProofShape(proof): string[]          // empty means valid
validateBrand|validateSpecimen|validateRendition|validateScene|validateBlock|validateMedia(value, path, errs): void
blockText(block): string[]                   // one string per rendered text run
countWords(blocks): number
```

### `src/core/prng.js`

```js
class Pcg32 { constructor(seed, stream?); nextU32(); nextFloat(); nextInt(bound);
              nextRange(min,max); shuffled(items); pick(items); nextGaussian(); reset() }
class SeedBook { constructor(seed); stream(name): Pcg32; fresh(name): Pcg32; resetAll() }
toU64(v): bigint
fnv1a64(s): bigint
DEFAULT_SEED = 'pitchproof-v1'
```

**Substream names are namespaced by lane** so two lanes never collide:
`brand/kmeans`, `brand/derive`, `specimen/sample`, `recipe/<recipeId>`,
`scene/<sceneId>`, `emit/budget`, `validate/corpus`, `test/<name>`.

### `src/core/hash.js`

```js
sha256Bytes(bytes): Uint8Array
sha256Hex(str): string
fnv1a32(str): number                  // FNV-1a over UTF-8 bytes; matches published vectors
stableStringify(value): string        // sorted keys, no whitespace, rejects non-finite
contentHash(value): string            // 64 hex
shortHash(value, len=12): string
```

### `src/core/ids.js`

```js
ID_PREFIX: Record<kind, string>
contentId(kind, payload): string      // `${prefix}_${shortHash(...)}`
class IdMinter { constructor(seed?, substream?); next(kind): string; reset() }
elementId(sceneId, path): string      // `el_<10 hex>` — stable across studio, sweep and artifact
isMintedId(id): boolean
```

### `src/core/bytes.js`

```js
utf8Encode/utf8Decode, base64Encode/base64Decode, toHex/fromHex,
concatBytes(...parts), utf8Length(str),
parseDataUri(uri): {mime, base64, body, bytes} | null
```

### `src/core/deflate.js` / `src/core/inflate.js`

```js
deflateRaw(bytes): Uint8Array         // raw DEFLATE, deterministic
inflateRaw(bytes, expectedSize?): Uint8Array
```

### `src/core/zip.js`

```js
class ZipArchive { constructor(bytes); entries; index; has(name); bytesOf(name); textOf(name); match(pred) }
readCentralDirectory(bytes): ZipEntry[]
readEntry(bytes, entry): Uint8Array   // CRC-verified; throws on mismatch
crc32(bytes): number
ooxmlKind(zip): 'docx'|'pptx'|'xlsx'|'unknown'
readRelationships(zip, partName): Map<string, {type, target, external}>
resolvePart(dir, target): string
parseXmlAttrs(tagBody): Record<string,string>
decodeXmlEntities(s): string
xmlText(xml): string
mimeForPart(name): string
```

### `src/core/vdom.js`

```js
h(tag, attrs?, ...children): VElement
raw(html): VRaw
cx(...parts): string
styleString(styleObject): string
escapeText(s) / escapeAttr(s): string
toHtml(node): string                  // what the emitter writes
toDom(node, document, svg?): Node
mount(rootElement, node): void
walk(node, visit, path?): void        // visit returns false to prune
textOf(node): string
findByAttr(node, attr, value): VElement|null
collectByAttr(node, attr): VElement[]
VOID_ELEMENTS: Set<string>
```

### `src/core/text-metrics.js`

The measurement service. **Every text measurement in the product goes through
it** — L5's `metricDelta`, L8's layout sizing, L11's overflow detection.

```js
UNITS_PER_EM = 1000
AFM_TABLES: Record<'Helvetica'|'Helvetica-Bold'|'Times-Roman'|'Times-Bold'|'Courier', AfmTable>
FAMILY_MODELS: FamilyModel[]
FALLBACK_CANDIDATES: string[]
AVG_ADVANCE_CORPUS: string

normalizeFamily(family): string
parseFamilyList(cssValue): string[]
lookupFamily(family): FamilyModel|null
guessCategory(family): 'sans'|'serif'|'mono'|'display'
metricsFor(family, weight=400): ResolvedMetrics    // {table, widthScale, capHeight, xHeight, avgAdvance, exact, known, category}
advanceOfCodepoint(cp, metrics): number            // per mille
advanceOfString(text, metrics): number             // per mille
isWideCodepoint(cp): boolean
applyTransform(text, textTransform): string
segments(text): {text, trailingSpace}[]

measureText(text, style): number                   // CSS px
layoutText(text, style, options): TextLayout
capHeightPx(family, fontSizePx, weight?): number
xHeightPx(family, fontSizePx, weight?): number
metricDelta(requested, fallback, weight?): {capHeight, xHeight, avgAdvance}
metricDistance(a, b): number
resolveFace(family, {available?, weight?}): FaceResolution
cssFontFamily(stack): string
```

```ts
type TextStyle = {
  family: string; weight?: number; fontSizePx: number;
  letterSpacingPx?: number; wordSpacingPx?: number; lineHeight?: number;   // lineHeight unitless, default 1.2
  textTransform?: 'none'|'uppercase'|'lowercase'|'capitalize';
};
type LayoutOptions = {
  maxWidthPx: number;
  whiteSpace?: 'normal'|'nowrap'|'pre'|'pre-wrap';
  overflowWrap?: 'normal'|'break-word'|'anywhere';
  maxLines?: number;               // -webkit-line-clamp
};
type TextLayout = {
  lines: {text: string, widthPx: number}[];   // widthPx excludes collapsed trailing whitespace
  lineCount: number; maxLineWidthPx: number; heightPx: number; lineHeightPx: number;
  unbreakable: string[];           // segments wider than the container on their own
  clamped: boolean;
};
type FaceResolution = {
  requested: string; resolved: string; stack: string[];
  metricDelta: {capHeight, xHeight, avgAdvance};
  available: boolean; known: boolean; confidence: number;   // 0..1
};
```

**`resolved` is the face that will actually render.** L11 must measure against
`resolveFace(...).resolved`, never against the requested family — that is what
"post-substitution" means in §14 and §22.2.

### `src/core/storage.js`

```js
SCHEMA_VERSION = 1, DB_NAME, STORE_PROJECTS, STORE_META, PRESSURE_WARN_RATIO = 0.8
MIGRATIONS: Record<number, (rec) => rec>
migrateRecord(rec): Result<ProjectRecord>
makeRecord({id, name, proof, seed, revision?, clock}): ProjectRecord
class MemoryBackend / class IndexedDbBackend
selectBackend({indexedDB?, memoryQuota?}): Promise<{backend, degraded: string|null}>
class ProjectStore {
  static open({clock, indexedDB?, memoryQuota?}): Promise<ProjectStore>
  save({id, name, proof, seed, force?}): Promise<Result<{record, skipped, pressure}>>
  load(id): Promise<Result<ProjectRecord>>
  list(): Promise<summary[]>
  remove(id): Promise<Result<true>>
  getSetting(key, fallback?) / setSetting(key, value)
  pressure(): Promise<{level:'ok'|'warn'|'critical', usage, quota, ratio}>
  onPressure(fn): () => void
  close(): void
  degraded: string|null
}
exportProjectJson(record): string
importProjectJson(text): Result<ProjectRecord>
```

`clock` is **injected** and returns an ISO string. No lane calls `Date.now()`
(see `scripts/lint-determinism.mjs`).

### `src/core/command.js`

```js
class CommandStack extends Emitter {
  constructor(initialState, {limit?})
  state; canUndo; canRedo; undoLabel; redoLabel
  run(command): S
  transaction(label, body, {scope?, meta?}): S
  undo(): S; redo(): S; undoUntil(pred): S; reset(state): S
  history(): {label, scope, meta, seq}[]
  // emits 'change' with {kind: 'run'|'coalesce'|'undo'|'redo'|'reset', label, state}
}
replaceCommand(label, before, after, {coalesceKey?, scope?, meta?}): Command
editCommand(label, current, updater, options?): Command
```

**Every model mutation in the studio goes through `CommandStack.run`.** There is
no second writer (§15).

### `src/core/result.js`, `src/core/events.js`

```js
ok(value) / err(error, detail?) / attempt(fn) / attemptAsync(fn)
class Emitter { on(type, fn): () => void; once; off; emit(type, ...args); clear() }
```

---

## Part 2 — L2 Runtime (landed, frozen)

Everything below is re-exported from `src/runtime/index.js`.

### Deck — `src/runtime/deck.js`

```js
SPINE = 'spine'
buildDeck(proof): Deck
sequenceOf(deck, sequenceId): Sequence      // throws on unknown
sceneAt(deck, sequenceId, sceneIndex): Scene|null
branchesFrom(deck, sceneId): Sequence[]
allBranches(deck): Sequence[]               // spine order of first anchor, then unanchored
beatCount(sequence): number
```

```ts
type Sequence = { id: string; kind: 'spine'|'branch'; scenes: Scene[];
                  returnPolicy: 'anchor'|'nextSpineScene'|null; objection: string|null; aliases: string[] };
type Deck = { sequences: Map<string, Sequence>; spine: Sequence;
              sceneLocator: Map<string, {sequenceId, sceneIndex}>;
              anchorsByScene: Map<string, string[]>; sceneById: Map<string, Scene>;
              proof: Proof; fingerprint: string };
```

### Navigation — `src/runtime/nav.js`

```js
initialState(deck): NavState
navigate(deck, state, action): NavState      // pure
checkInvariants(deck, state, actionName): NavState   // throws NavInvariantError
class NavInvariantError extends Error
beatsOf(scene): number                       // always >= 1
offSpine(state): boolean
currentScene(deck, state): Scene|null
peekNext(deck, state): NavState
stateHash(deck, state, {blanked?, overlay?}?): string
allPositions(deck): {sequenceId, sceneIndex, beatIndex, sceneId}[]
```

```ts
type NavState = { sequenceId: string; sceneIndex: number; beatIndex: number;
                  stack: ReturnFrame[]; visited: string[];
                  // `stack` here is the WHOLE stack the automatic exit unwound,
                  // not its top frame: `nextSpineScene` unwinds all of them.
                  exitedFrom: {from: {sequenceId, sceneIndex, beatIndex}, stack: ReturnFrame[]} | null };
type ReturnFrame = { sequenceId; sceneIndex; beatIndex; returnPolicy: 'anchor'|'nextSpineScene'; branchId };
type NavAction =
  | {type:'nextBeat'} | {type:'prevBeat'} | {type:'nextScene'} | {type:'prevScene'}
  | {type:'firstScene'} | {type:'lastScene'}
  | {type:'jump', branchId} | {type:'goToScene', sceneId} | {type:'goToBeat', sceneId, beatIndex}
  | {type:'return'} | {type:'returnToSpine'};
```

Invariants, checked on every transition: stack depth never negative; the stack
is empty **iff** the active sequence is the spine; the stack floor is always the
spine; the position always names a real scene and a real beat.

### Beats — `src/runtime/beats.js`

```js
REVEAL_ATTR = 'data-pp-el'
REVEALED_CLASS = 'pp-revealed'; ENTERING_CLASS = 'pp-entering'; EXIT_TRANSITION_MS = 0
revealedAt(scene, beatIndex): Set<string>
newlyRevealedAt(scene, beatIndex): string[]
sceneRevealsNothing(scene): boolean
visibilityOf(scene, beatIndex, elementId): {visible, entering}
scrollTargetFor(scene, beatIndex): string|null
beatFrame(scene, beatIndex): BeatFrame
beatSignature(scene, beatIndex): string
transitionMs(requestedMs, reducedMotion): number   // capped at 240, 0 under reduced motion
dwellHintLabel(beat): string|null                  // display only — never a timer
```

**Every element a beat can reveal must carry `data-pp-el="<elementId>"`.** L8
mints those ids with the `el()` helper on the layout context, and L11 reads them
back. An element without the attribute is always visible.

### Keyboard — `src/runtime/keymap.js`

```js
BINDINGS: Binding[]
resolveKey(event, {overlay, typing, blanked}?): {command, binding}|null
bindingGroups(): {group, bindings}[]
keyLabel(binding): string
allCommands(): string[]
```

Commands: `nextBeat prevBeat nextScene prevScene firstScene lastScene openJump
toggleMap toggleContents toggleHelp returnToSpine toggleBlank togglePresenter
toggleFullscreen escape`, plus `jump` and `goToScene` which take a payload.

### Overlays — `src/runtime/overlays.js`

```js
OVERLAY = {jump: 'jump', map: 'map', contents: 'contents', help: 'help'}
class OverlayStack extends Emitter {
  register(def): () => void
  open(id, {activeElement?}): boolean
  close(id?): string|null
  closeAll(): void
  toggle(id, env?): boolean
  handleNavigation(): void
  takeFocusBefore(): Element|null
  topDefinition(): OverlayDefinition|null
  top: string|null; isOpen: boolean; stack: string[]
}
trapFocus(rootElement, event): boolean
focusableWithin(rootElement): HTMLElement[]
FOCUSABLE_SELECTOR: string
```

```ts
type OverlayDefinition = { id: string; title: string; takesFocus: boolean;
                           dismissOnNavigate?: boolean;   // false = survives navigation
                           render: (ctx: OverlayContext) => VNode };
type OverlayContext = { runtime, deck, nav, scene, branches, branchesHere, visited, mode,
                        run: (command, payload?) => boolean };
```

**L9 registers `jump`, `map` and `contents`** on `runtime.overlays` and must
give `jump` `takesFocus: true`.

### Layouts — `src/runtime/layouts.js`

```js
registerLayout(name, fn): () => void      // name must be one of the eight §4 layouts
getLayout(name): LayoutFn|null
registeredLayouts(): string[]
missingLayouts(): string[]
resetLayouts(): void
renderLayout(ctx): VNode
placeholderLayout(ctx): VNode
```

```ts
type LayoutContext = {
  scene: Scene; brand: BrandSystem; specimen: Specimen|null; renditions: Rendition[];
  media: Map<string, MediaRef>;
  el: (path: string) => string;      // stable element id — use for every revealable element
  labelIllustrative: boolean;        // §9: render a visible label when a rendition is illustrative
  mode: 'presenter'|'review';
};
type LayoutFn = (ctx: LayoutContext) => VNode;
```

A layout **must not** see or use the beat index. It renders the scene's full
content once; the beat engine decides visibility.

### Runtime — `src/runtime/runtime.js`

```js
class Runtime extends Emitter {
  constructor(proof, {mode?, reducedMotion?, labelIllustrative?, presenterAvailable?})
  deck; nav; overlays; blanked; presenterOpen; mode; reducedMotion;
  labelIllustrative; presenterAvailable; includePresenterNotes
  specimenById; renditionById; mediaById: Map
  scene: Scene|null; frame: BeatFrame|null; offSpine: boolean
  snapshot(); hash(); progress(); upNext()
  go(action): boolean
  run(command, payload?): boolean
  handleKey(event, {typing?, activeElement?}): string|null
  setBlanked(bool): boolean; setPresenterOpen(bool): boolean
  layoutContext(scene): LayoutContext
  renderScene(scene?): VNode
  render(): VNode
  overlayContext(): OverlayContext
  // emits 'change' {reason, state}, 'presenter' {open}, 'request' {kind}
}
applyBeat(vnode, beatFrame): VNode
renderHelpOverlay(): VNode
```

### Host and presenter — `src/runtime/host.js`, `src/runtime/presenter.js`

```js
STAGE_ROOT_ID = 'pp-stage-root'
PRERENDERED_ATTR = 'data-pp-prerendered'
class RuntimeHost { constructor(runtime, {document, root?, window?}); attach(); detach();
                    paint(); applyScroll(); toggleFullscreen() }
isTextEntry(el): boolean
cssEscape(value): string
firstPaintTree(runtime): VNode
renderToNode(vnode, document): Node

class ManualTimer { constructor(nowMs); start(); pause(); toggle(); reset(); elapsed(); label() }
renderPresenterView(runtime, {timerLabel?, timerRunning?}): VNode
openPresenterWindow(runtime, {window, nowMs}): {opened, close, refresh, timer}
PRESENTER_CSS: string
```

### Boot — `src/runtime/index.js`

```js
boot({proof, document, window?, root?, nowMs?}): {runtime, host, presenter}
RUNTIME_VERSION = '1.0.0'
```

The emitted artifact calls `boot`. The document already contains the opening
beat as static HTML marked with `data-pp-prerendered`, so `boot` hydrates rather
than repaints.

### Artifact CSS

`src/runtime/runtime.css` and every stylesheet under `src/scene/` are bundled
into `dist/pitchproof-runtime.css`. **Artifact variables are `--pp-*` only**;
studio chrome is `--st-*` only (D11). Classes the runtime owns and layouts must
not redefine: `pp-stage`, `pp-scene`, `pp-blank`, `pp-revealed`,
`pp-unrevealed`, `pp-entering`, `pp-overlay-layer`, `pp-overlay`,
`pp-branch-badge`, `pp-provenance`.

---

## Part 3 — Lane surfaces (binding on the lane that owns them)

Each lane creates `src/<dir>/index.js` exporting exactly this.

### L3 Ingest — `src/ingest/index.js`

```js
parseHtml(source): DocNode                      // in-repo parser (D8)
querySelectorAll(node, selector): DocNode[]      // supports tag, .class, #id, [attr], descendant
textContent(node): string
attr(node, name): string|null

fetchStrategies(): Strategy[]
ingestUrl(url, {proxyBase?, http?, clock}): Promise<Result<RawCapture>>
importSavedPage(files, {clock}): Promise<Result<RawCapture[]>>
importHar(text, {clock}): Result<RawCapture[]>
importMhtml(text, {clock}): Result<RawCapture[]>
importHtmlText(html, {sourceUrl?, clock}): Result<RawCapture>
importOoxml(bytes, {name, clock}): Result<RawCapture>
importPdf(bytes, {name, clock}): Result<RawCapture>
importImage(bytes, {name, mime, clock}): Result<RawCapture>

discoverSitemap(base, {http}): Promise<Result<SitemapEntry[]>>
rankCandidates(entries): SitemapEntry[]          // by structural richness, not position
```

```ts
type RawCapture = {
  kind: 'html'|'document'|'image';
  sourceUrl: string|null; capturedAt: string;    // from the injected clock
  html: string|null; doc: DocNode|null;
  blocks: ContentBlock[]|null;                   // set by document/image importers
  assets: {name: string, bytes: Uint8Array, mime: string}[];
  meta: Record<string, string>;
  strategy: string;
};
type DocNode = { type: 'element'|'text'|'comment'; tag?: string;
                 attrs?: Record<string,string>; children?: DocNode[]; text?: string; parent?: DocNode };
```

`http` is injected: `(url, init) => Promise<{ok, status, text(), bytes()}>`. No
lane calls a global network API directly, so tests drive ingest with a stub and
the studio supplies the real one.

### L4 Brand colour — `src/brand/color.js`

```js
srgbToLinear(c) / linearToSrgb(c): number
hexToRgb(hex): [number, number, number]         // 0..255
rgbToHex(rgb): string
rgbToOklab(rgb): [number, number, number]
oklabToRgb(lab): [number, number, number]
oklabToOklch(lab) / oklchToOklab(lch): [number, number, number]
hexToOklch(hex) / oklchToHex(lch): ...
relativeLuminance(rgb): number                  // WCAG 2.1, exact
contrastRatio(hexA, hexB): number
inGamut(lch): boolean
clampChromaToGamut(lch): [number, number, number]

quantize(pixels, {k, seed}): Cluster[]          // seeded k-means in OKLab
chooseK(pixels, {seed, range: [3,8]}): number   // silhouette
solveRoles(clusters, {seed}): ColorToken[]      // §7 cost-function solve; post-condition: every onX >= 4.5:1
deriveForContrast(baseHex, targetHex, minRatio): string   // walk L in OKLCH, hold H, clamp C
colorConfidence(clusters, sources): number      // 0..1, computed
```

`solveRoles` **must** return a palette in which every `FOREGROUND_ROLES` entry
reaches 4.5:1 against `ROLE_PAIR[role]`, deriving colours where extraction
cannot. It throws rather than returning a failing palette.

### L5 Brand type / logo / shape — `src/brand/theme.js`

```js
detectFaces(doc, css, {available?}): TypeFace[]        // uses core/text-metrics resolveFace + metricDelta
attachUserFont(face, {bytes, dataUri, weights, rightsAssertion}): TypeFace   // the ONLY route to embeddable: true
extractLogos(doc, assets, {idMinter}): LogoAsset[]
inverseVariant(logo): LogoAsset|null                   // only when monochrome; null otherwise
detectShape(css): {radiusPx, borderWidthPx, shadowLevel}
classifyImagery(images): {treatment, saturationBias}
buildBrandSystem(parts, {clock, idMinter}): BrandSystem
compileTheme(brand): {css: string, vars: Record<string, string>}   // --pp-* only
```

`compileTheme` emits the `--pp-*` custom properties the artifact stylesheet
reads. It must never emit a `--st-*` name.

`attachUserFont` is declared here rather than as a Part 5 extra because §7 makes
it a **law**: *"`embeddable` is false unless the user explicitly supplies a font
file they assert they have rights to."* It is the only route to `embeddable:
true`, and nothing may set the flag directly. Leaving it out of this fence is how
the studio went a whole pass without offering any way to supply a font while
shipping a checkbox that asserted a licence for a file nobody had — a claim
changing without a fact changing, which is the failure §18 exists to prevent
(CRITIQUE-2 C3, dispute D-L12-9).

### L6 Specimen — `src/specimen/index.js`

```js
stripChrome(doc, {siblings?}): {root: DocNode, removed: {node, reason, score}[]}
toBlocks(root, {media}): ContentBlock[]
captureMedia(assets, {imageQuality, maxEdge, idMinter}): MediaRef[]
detectLocale(doc, url): string|null
buildSpecimen(capture, {kind?, imageQuality, clock, idMinter}): Specimen
restoreBlock(specimen, removedEntry): Specimen         // stripping is reversible
```

### L7 Recipes — `src/recipe/index.js`

```js
SEED_RECIPES: Recipe[]                                  // all eight from §9
recipeById(id): Recipe|null
alignBlocks(sourceBlocks, pastedBlocks): {pairs: [number|null, number|null][], score: number}
parsePasted(text): ContentBlock[]
buildRendition({specimen, recipe, label, blocks, media, producedBy, provenance?, notes?}): Rendition
promoteProvenance(rendition, {by, at}): Rendition       // records who and when; the only route to verified-by-user
channelBudget(label): {maxChars: number, maxWords: number}|null
enforceBudget(blocks, budget): {blocks, overBy: number}
runAdapter(recipe, specimen, {endpoint, key, http}): Promise<Result<Rendition>>   // always stamps 'illustrative'
```

**Provenance law.** `buildRendition` defaults to `'illustrative'` unless the
caller passes `'client-supplied'`. `producedBy: 'adapter'` forces
`'illustrative'`. Nothing but `promoteProvenance` may produce
`'verified-by-user'`, and it records a promotion entry in `rendition.notes`.

### L8 Scenes — `src/scene/index.js`

```js
registerAllLayouts(): void                              // registers all eight with L2's registry
sceneTemplates(): {layout, name, describe}[]
buildScene({layout, specimen, renditions, headline, subhead, idMinter}): Scene
measureScene(scene, ctx, breakpoint): SceneMeasurement   // for L11's overflow detector
PROVENANCE_LABEL_CLASS = 'pp-provenance'
```

```ts
type SceneMeasurement = {
  sceneId: string; breakpoint: 'sm'|'md'|'lg';
  boxes: { elementId: string|null; role: string; text: string;
           style: TextStyle; containerWidthPx: number; containerHeightPx: number;
           whiteSpace?: string; overflowWrap?: string; maxLines?: number;
           textOverflow: 'clip'|'ellipsis';       // always present, derived from the CSS
           fontStack?: string[]; containerId?: string; slot?: string;
           fitsContent?: boolean }[];             // width is the room this box has, not the box it fills
};
```

Every text box a layout renders must appear in `measureScene`, with the
container dimensions the CSS gives it at that breakpoint. **This is the input
§22.2 depends on**: if a layout renders text it does not measure, the overflow
detector cannot see it.

Every illustrative rendition a layout renders must carry an element with class
`pp-provenance` inside the same subtree. L10 asserts it at emit.

`textOverflow` is **always present** and is derived from the stylesheet, never
authored: `'ellipsis'` where the element carries `data-pp-clamp` (the one-line
rule declares `text-overflow: ellipsis` outright), `'clip'` otherwise; a layout
may state it directly with `data-pp-to`. `test/scene/css-agreement.test.mjs`
parses `scenes.css` and asserts the declared value for every clamp the layouts
actually stamp, so measurement and stylesheet cannot drift.

This field is what §22.2's **severity** hangs on, which is why it is not
optional. L11 grades on whether the viewer can see that text was cut: `clip` is
severity 1, `ellipsis` is severity 2, and an undeclared value is severity 1
because that is CSS's own initial value. Height overflow is ungraded by it —
`text-overflow` is horizontal, and text running past the bottom of a box carries
no ellipsis anywhere.

Boxes that stack in one column share a `containerId` (`splitCell:before`,
`sideNote:notes`, `indexRow:index`, …), which is how L11 aggregates cumulative
overflow across siblings. A box's *position* within its container is still
unavailable — a documented gap (dispute 25), not a worked-around one.

**`containerWidthPx` is the width Chromium draws, and that is a checked claim.**
`test/scene/geometry-browser.test.mjs` lays every layout out in real Chromium at
all three `BREAKPOINTS` viewports and fails when any measured container differs
from the rendered box by more than a pixel of rounding. It was written because
CRITIQUE-2's C1 found 980 of 2547 text boxes disagreeing with the model, the
worst by 1259px, while every in-lane check passed: the stylesheet and the token
table agreed with each other and neither had been compared to a browser.

Two elements in the deck are sized by their own words rather than by their row —
the `inline-flex` provenance pill and the `inline-block` CTA. For those,
`containerWidthPx` is **the room the element has**, not the box it fills: what a
longer label, or the same label in another brand's face, would need. The
rendered box is never wider than the reported number, so §22.2's error falls
towards a warning that is not needed rather than a truncation nobody sees. Those
boxes report `fitsContent: true`, so the two meanings of `containerWidthPx` are
told apart in the data rather than only in this paragraph, and the set is
asserted in that test so it cannot grow by accident.

**Optional `dir` / `lang` on a block or a rendition (CRITIQUE-2 C8).** §4's
`ContentBlock` and `Rendition` carry no writing direction, and §9.1 asks
`locale-fanout` for "locale-appropriate structure, not just translated strings".
L7 writes the fact as optional extensions — `withDirection` / `carryDirection` in
`src/recipe/blocks.js` — and L8 reads it:

```ts
// optional, on ContentBlock and on Rendition
dir?: 'ltr' | 'rtl' | 'auto';
lang?: string;      // BCP-47
```

A block's value wins over its rendition's, because a rendition mixes the
source's language with the tool's own structural labels and no single tag is
true of the whole of it. Absent or malformed values produce **no attribute**: a
deck that declares nothing renders byte-identically to one built before the
fields existed, and no direction is ever inferred from the text. A rendition's
`label` and its `producedBy` line are the tool's words rather than the market's,
so the two layouts that render only those (`contentsIndex`, `systemMap`) carry
no direction — asserted in `test/scene/direction.test.mjs` rather than assumed.
Promoting the fields into §4 below the FROZEN REGION END marker is dispute
L8-D11.

### L9 Branches — `src/branch/index.js`

```js
buildJumpIndex(deck): JumpIndex
searchJump(index, query, {limit?}): {branchId, objection, score, matched}[]
registerBranchOverlays(runtime): () => void             // jump, map, contents
returnTargetFor(deck, branchId): {sequenceId, sceneIndex}|null
branchCoverage(deck): {unreachable: string[], noReturn: string[]}
randomWalk(deck, {seed, steps}): NavState[]             // used by the property test
```

`searchJump` is fuzzy over objection text and aliases; typing three characters
of "approvals" must rank the approval-chain branch first.

### L10 Emitter — `src/emit/index.js`

```js
emit(proof, options, deps): Promise<Result<EmitResult>>
scanForNetworkReferences(html): Finding[]               // §13 + D10 allowlist
assertProvenance(proof, html, css): Finding[]           // §9/§18/§22.6 — enforced here, not in the UI
budgetAssets(proof, maxBytes): {plan: DegradationLine[], proof: Proof}
inlineRuntime({runtimeJs, runtimeCss, themeCss, proof, firstPaintHtml}): string
```

```ts
type EmitResult = {
  html: string; bytes: number;
  findings: Finding[];                    // severity 1 present => emit refused
  degradations: DegradationLine[];        // predicted and actual bytes, per asset
  compression: {mode: 'deflate'|'raw', modelBytes: number, mediaBytes: number};
};
type DegradationLine = { assetId: string; rank: number; from: {w,h,quality}; to: {w,h,quality};
                         predictedBytes: number; actualBytes: number; reason: string };
```

`deps` carries `{runtimeJs, runtimeCss, clock}` so the emitter never reads the
filesystem. **A severity-1 finding refuses the emit. There is no override flag
anywhere in the codebase.**

### L11 Validate — `src/validate/index.js`

```js
runPreflight(proof, {breakpoints?, clock, runtimeJs?, runtimeCss?}): Promise<Finding[]>
RULES: Rule[]                                            // one per FindingCode
detectOverflow(measurement, brand): Finding[]
checkContrast(brand): Finding[]
autoFixes(proof, findings): {finding: Finding, label: string, apply: (proof) => Proof}[]
dryRun(proof, {onPosition}): Promise<{positions: number, findings: Finding[]}>
severityOf(code): 1|2|3
```

Severity is fixed for the codes in `FIXED_SEVERITY` and may not be lowered.

### L12 Studio UI — `src/ui/index.js`

```js
mountStudio({document, window, store, clock, runtimeJs, runtimeCss}): StudioApp
```

`src/ui/shell.html` provides the document shell with the three markers
`<!--PITCHPROOF_STYLES-->`, `<!--PITCHPROOF_RUNTIME-->`,
`<!--PITCHPROOF_SCRIPT-->` that `scripts/build.mjs` fills in.

---

---

## Part 3b — the cross-lane optional extensions

§4's frozen contracts take **optional** additions below the FROZEN REGION END
marker. Most are one lane's private business. These are not: more than one lane
reads them, so their shape and their resolution rule belong here.

### Writing direction and language — L7 writes, L8 renders

```ts
interface ContentBlock { dir?: 'ltr' | 'rtl' | 'auto'; lang?: string; pre?: boolean }
interface Rendition    { dir?: 'ltr' | 'rtl' | 'auto'; lang?: string }
```

**Resolution: a block's value wins; the rendition's is the fallback for blocks
that declare nothing.** L7 publishes `DIRECTIONS`; L8's `src/scene/direction.js`
publishes the same three values and `resolveFlow(block, container)` implements
the rule. The two lanes arrived at this shape independently in the same pass,
which is the strongest evidence available that it is the right one.

**Why both levels.** They answer different questions, and the asymmetry is the
argument. Direction is a property of the *rendition* — the whole ar-SA card,
table and CTA and captions included — and it survives a layout subsetting the
blocks. Language is a property of a *run of text*, because a rendition mixes the
source's words with the tool's own English labels, so no single tag is true of
the whole of it. `locale-fanout` therefore sets `Rendition.dir`, `dir` on every
block, and `lang` per block, and deliberately sets **no** `Rendition.lang`.

**`dir` is the market's; `lang` is the source's — never the other way round.**
The ar-SA rendition still shows LTR Latin text, because inventing Arabic copy
would be fabrication (§18.2). Marking that text `lang="ar-SA"` would be a false
claim about the content, and worse than most in one respect: it hands a screen
reader an Arabic voice for English words. Where the specimen declares no
language, nothing is claimed.

This exists because §9.1 asks `locale-fanout` for *"locale-appropriate
structure, not just translated strings"* and the ar-SA rendition was arriving as
`raw` blocks, which §8 correctly makes a layout flatten to text under "Source
markup, shown as text" — so the Arabic-market card rendered left-to-right,
labelled as the prospect's own page source (CRITIQUE-2 C8). Two rules collided
and the wrong one won: §8 is about *captured* source, and a rendition a seed
recipe produced is not captured source. `raw` now means what it says.

`pre` is secondary and degrades safely: a layout that ignores it renders a
paragraph, which is exactly what the `raw` block rendered as after `stripTags`,
minus a caption that was untrue.

### `Deck.duplicateBranchIds` — L2 writes, L11 and L12 read

```ts
interface Deck { duplicateBranchIds: string[] }
```

Branch ids the proof declared more than once, or which collided with the spine's
reserved `'spine'`. `buildDeck` keeps the **first** occurrence and drops the
rest — the same collision policy it already applied to scene ids, applied once
instead of twice in opposite directions.

Recorded rather than thrown, because `runPreflight` builds the deck *before*
running the rules: a throwing `buildDeck` would replace L11's severity-1 finding
— which names both branches to rename — with an exception, and the seller would
get a crash where they now get a sentence. The list is how the studio preview,
the rehearse walk and the branch panel find out that the deck is not the proof.


## Part 4 — The build

```
node scripts/lint-determinism.mjs      # no unseeded randomness or clock reads in src/
npm test                               # node --test over test/**/*.test.mjs
node scripts/build.mjs --verify-repeat # two builds, byte-identical
node scripts/verify-offline.mjs        # headless, network blocked, keyboard walk, FCP budget
```

`scripts/lib/bundler.mjs` handles: relative imports with explicit `.js`
extensions, named/namespace/default imports, `export function|class|const|let|var`,
`export { a, b as c }`, and `export { a } from './x.js'`. It refuses bare
imports, `export *`, `export default`, dynamic `import()`, and import cycles.
**Write source it can compile.**

---

## Part 5 — Surfaces the lanes published beyond Part 3

Part 3 declared the minimum each lane had to publish. Lanes published more, and
some of those extras are load-bearing across lanes. These are declared here and
checked by `test/integration/api-conformance.test.mjs`, so a lane cannot quietly
withdraw something another lane depends on.

| Lane | Module | Export | Who needs it |
|---|---|---|---|
| L3 | `ingest/index.js` | `ingestFile`, `ingestFiles` | L12's drop dispatch |
| L3 | `ingest/index.js` | `importPageImages` | D9's explicit page-image path |
| L3 | `ingest/index.js` | `parseXml`, `serialize`, `plainTree` | The XML reader, and an acyclic copy of a `DocNode` tree (dispute 29) |
| L3 | `ingest/index.js` | `imageSize`, `sniffMime`, `toDataUri` | L6's media capture |
| L4 | `brand/color.js` | `extractPalette` | The one-call pipeline L5's `buildBrandSystem` consumes |
| L4 | `brand/color.js` | `colorConfidenceDetail` | §7's low-confidence review surface |
| L4 | `brand/color.js` | `ContrastSolveError` | `solveRoles` throws it; callers must handle it |
| L5 | `brand/theme.js` | `assertNoStudioVars` | D11 made mechanical: throws on any `--st-` name in artifact CSS |
| L6 | `specimen/index.js` | `unresolvedMediaRefs` | L11's `ASSET_MISSING` |
| L6 | `specimen/index.js` | `restoreOmittedMedia`, `omitUnresolvedMedia` | A `media` block whose bytes were never captured is held out of the stream rather than emitted as a reference that refuses the artifact (CRITIQUE-3 P6). `restoreOmittedMedia` puts it back, in position, when the seller supplies the file |
| L6 | `specimen/index.js` | `setRawHtmlOptIn`, `rawFallbackBlocks` | §8's per-specimen raw opt-in |
| L6 | `specimen/index.js` | `markEdited` | §18.3's "if a specimen was edited, the artifact says so" |
| L6 | `specimen/index.js` | `inferKind`, `blocksWithTrace`, `restoreAllBlocks` | L12's specimen panel |
| L7 | `recipe/index.js` | `renderRecipe`, `renderAll`, `RECIPE_TEMPLATES` | **How a caller actually gets renditions out of a recipe.** L12 depends on it |
| L7 | `recipe/index.js` | `hasPromotionRecord`, `verifyProvenance`, `renditionsRequiringLabel`, `PROMOTION_RECORD_RE` | L10 and L11 must detect a `verified-by-user` claim carrying no promotion record |
| L7 | `recipe/index.js` | `assertNoAdapterSecrets`, `assertNoFabricatedFacts` | §9 and §18.2 enforcement points |
| L9 | `branch/index.js` | `installBranchInputBridge` | Required for `/` to work; the composition root calls it |
| L9 | `branch/index.js` | `branchGraph`, `nestingDepths`, `highlightRuns` | L11's coverage grading and the jump overlay |
| L10 | `emit/index.js` | `scanModelAssets` | A `MediaRef` or logo pointing at the network, reported rather than dropped |
| L10 | `emit/index.js` | `artifactRuntimeSource` | The composition-root bundle the artifact carries |

### Closed gap — imagery classification is reachable

`classifyImagery` needs `ImageSample`s, and for a while no published surface
built them: `sampleFromPng` lived in `src/brand/imagery.js` and was not
re-exported, so the studio could not reach it and imagery came back `unknown`
with zero confidence, held by the §7 review gate rather than guessed. Filed as
dispute 35 and L12's `D-L12-3`.

Closed by L5 (L5-D25). `brand/theme.js` now re-exports `sampleFromPng`,
`classifyImage` and `normalizeSample`, **and** `buildBrandSystem` accepts an
`images` entry in either shape — a decoded `ImageSample`, or L3's raw
`{name, bytes, mime}` record, which it decodes itself and skips when it cannot
read the format. The wiring cannot be got half right: a caller passing what L3
produces gets a real classification, and `brand.imagery.treatment` is
non-`unknown` with non-zero confidence straight from raw PNG bytes.

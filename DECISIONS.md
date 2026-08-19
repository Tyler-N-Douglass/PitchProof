# DECISIONS

Every judgment call the spec did not settle, with its rationale, per §23. Newest
sections are appended; nothing here overrides `PITCHPROOF-BUILD-SPEC-v1.0.md`.

---

## D1 — Authoring language: plain ES modules with JSDoc, not TypeScript

**Unsettled by:** §5 gives the source layout and says "authored as modules,
bundled to single files by a small esbuild script", and §4 states the contracts
in TypeScript, but does not say the implementation is TypeScript.

**Decision.** `src/**` is plain ESM JavaScript with JSDoc types. The frozen §4
interfaces live verbatim in `src/core/contracts.d.ts` as the single normative
declaration, and `src/core/contracts.js` carries their runtime companions (closed
enumerations, the role-pair table, defaults, a shape validator).

**Why.** A TypeScript source tree needs a compiler in the loop before anything
runs, which fights §5's "no build step required to run the studio" and adds a
dependency the artifact laws would then have to trust. JSDoc keeps editor-level
type help and keeps the runtime honest: what ships is what was written. The
contract is enforced by a test rather than a compiler — see D2 — which is
stronger anyway, because a compiler cannot tell you a field was renamed *on
purpose*.

---

## D2 — Contract freezing is enforced by test, not convention

**Unsettled by:** §4 freezes the interfaces and §20.1 asks the critic to check
for "silent contract drift", but nothing specifies the mechanism.

**Decision.** The §4 `ts` block was extracted from the spec byte-for-byte into
`test/fixtures/frozen-contracts.txt`. `src/core/contracts.d.ts` contains that
text inside `FROZEN REGION BEGIN/END` markers, and a test diffs the two. Optional
lane extensions are only legal below the END marker.

**Why.** It converts "no lane may rename, retype, or remove a field" from a
social rule into a build failure, and it gives the critic a mechanical answer to
axis 1 instead of a reading exercise.

---

## D3 — No npm dependencies in the build path

**Unsettled by:** §5 names esbuild specifically.

**Decision.** `scripts/build.mjs` is a purpose-written deterministic bundler for
the ESM subset this repo uses (named exports, relative imports, no dynamic
import, no circular dependencies). Playwright is the only dev dependency, used
solely by `verify-offline.mjs` and the browser cross-check tests — never by the
studio, the runtime, or the artifact.

**Why.** Three of the product's hard laws are about what ends up in the emitted
file. A bundler we own means the emitted bytes have no third-party origin and no
version drift, which makes byte-identical re-emit (§17.6) a property of this
repo rather than of a lockfile. The cost is a few hundred lines; the benefit is
that the determinism and zero-network laws are provable from source.

---

## D4 — Layouts render to a VNode tree, not to DOM

**Unsettled by:** §10 says each layout is "a pure function of (Scene,
BrandSystem, Specimen, Rendition[]) → DOM".

**Decision.** Layouts return a VNode tree (`src/core/vdom.js`). `toDom()` mounts
it in a browser; `toHtml()` serializes it. The spec's purity requirement is
satisfied and strengthened — the function is pure in the strict sense, since it
does not touch a document at all.

**Why.** Four spec requirements get easier and one gets possible:
- §14's automated sweep must walk every beat of every scene and measure it. With
  a tree, that runs under `node --test` with no browser.
- §17's layout, reveal, and overflow tests become ordinary unit tests.
- §13's emitter can serialize scene 0 to static HTML so the artifact paints
  before any JavaScript executes, which is how the §12 cold-boot budget is met
  rather than hoped for.
- §12 requires the studio preview and the artifact to agree. One tree rendered
  two ways guarantees it; two renderers would only promise it.

---

## D5 — DEFLATE is implemented in-repo rather than taken from `CompressionStream`

**Unsettled by:** §13 says to "consider deflate-compressing the payload and
inflating at runtime via `DecompressionStream`", naming only the decompression
side.

**Decision.** `src/core/deflate.js` implements raw DEFLATE (LZ77 + per-block
choice of dynamic Huffman / fixed / stored, with package-merge length-limited
code lengths). The artifact still *inflates* with the platform
`DecompressionStream('deflate-raw')`, which costs no bytes and is universally
available.

**Why.** `CompressionStream` output is implementation-defined: Chrome, Firefox
and Safari may each produce different bytes for the same input. §5's determinism
law requires two emits of the same project to be byte-identical, and §17.6
asserts it. Sourcing the compressor from the browser would make that assertion
true only per-machine. An in-repo compressor makes it true everywhere.

**Measured.** Against `zlib` level 9: JSON 1389 vs 1450 bytes, base64 1272 vs
1275, highly repetitive 210 vs 211. Round-trips verified both ways (our output
through `zlib.inflateRawSync`, and `zlib` output at levels 0/1/6/9 through our
inflater).

---

## D6 — Payload split: media stays uncompressed, model JSON is compressed

**Unsettled by:** §13 says to compress "the payload" without dividing it.

**Decision.** The emitted file carries two payloads: media as plain base64 data
URIs, and the proof model as a compressed, base64-encoded blob.

**Why.** Media is already in compressed formats. Putting it inside the deflate
stream and then base64-ing the result costs base64 expansion *twice* — roughly
1.39× the raw bytes — where leaving it outside costs 1.333× once, and 1.333× is
the floor for any single-file HTML document. Text, by contrast, compresses four
to six times over, so it belongs inside. The split also means media is usable the
instant the document parses, with no await on decompression, which protects the
cold-boot budget. Both variants are measured at emit and the smaller is kept, as
§13 requires.

---

## D7 — Text measurement is a deterministic service with published metrics

**Unsettled by:** §7 says to compute `metricDelta` "using an offscreen canvas
measurement"; §14 requires overflow measured "at all three breakpoints after the
brand's type substitution has been applied".

**Decision.** `src/core/text-metrics.js` carries published per-glyph advance
tables (the Adobe core AFM sets: Helvetica/Arial, Helvetica-Bold, Times-Roman,
Times-Bold, Courier) plus documented per-family scale models for families with no
public table, and implements greedy line breaking on top. Canvas measurement is
used in the browser to *calibrate and cross-check*, never as the sole source.

**Why.** A canvas measurement depends on which fonts the measuring machine has
installed. On this build machine, `Arial` resolves to Liberation Sans and
measures cap-height 0.69 where Arial's own font table says 0.716. If the golden
tests trusted the canvas, they would be asserting a property of the CI container.
Worse, §22.2 identifies post-substitution overflow as the defect that matters
most, and a detector that measures differently in rehearsal than in CI is not a
detector. A fixed table makes the answer the same in Node, in the studio and in
CI; families that fall back to the scale model are marked approximate and carry
lower confidence, and the browser cross-check reports the residual error rather
than hiding it.

---

## D8 — Ingest owns an in-repo HTML parser

**Unsettled by:** §6 and §8 assume HTML can be parsed; the browser provides
`DOMParser`, Node does not.

**Decision.** `src/ingest/html-parse.js` is a dependency-free HTML tokenizer and
tree builder (void elements, raw-text elements, implicit closes, attributes,
comments, entities) producing a light element tree. Both the browser path and the
Node path use it.

**Why.** §22.3 makes chrome stripping a top-three risk and §17.5 requires a
block-level F1 ≥ 0.9 measured against hand-labelled fixtures. That test has to
run in the ordinary test suite, not only in a browser job, or it will be skipped
the moment it is inconvenient. One parser also means the studio and the test
suite cannot disagree about what a page contains.

---

## D9 — PDF import extracts text and embedded images, not rendered page rasters

**Unsettled by:** §6.5 asks to "extract PDF text and page rasters".

**Decision.** The PDF importer parses the cross-reference table and object graph,
inflates content streams, extracts text via the text-showing operators (honouring
`ToUnicode` CMaps where present, falling back to WinAnsi/Standard encodings), and
extracts embedded images (`DCTDecode` lifted out directly as JPEG; raw bitmap
filters re-encoded). It does **not** rasterize pages. The studio offers an
explicit "import page images" path for users who need page-accurate visuals.

**Why.** Rasterizing a page means implementing a PDF renderer — graphics state,
path filling, blend modes, shading, embedded font rasterization. That is a
product in itself, it would dominate the schedule of a lane that also owns five
other ingest strategies, and a half-built renderer produces *wrong* pages, which
is worse for a proof artifact than no page. Text and embedded images cover what
specimens actually need, and the explicit image-import path covers the rest
without lying about fidelity.

---

## D10 — Network scanner allowlist

**Unsettled by:** §13 says to scan for `http://`, `https://`, `//`, `src=`,
`@import` and network constructors, and to fail on "any hit". Read literally,
that fails every legal artifact.

**Decision.** The scanner parses rather than greps. `src`/`href` attribute values
must be `data:`, a document-internal `#` fragment, or `about:blank`. The strings
`http://www.w3.org/2000/svg`, `http://www.w3.org/1999/xlink` and
`http://www.w3.org/1999/xhtml` are permitted **only** as `xmlns`/`xmlns:*`
attribute values, because they are namespace identifiers and never fetched.
Everything else — any other absolute or protocol-relative URL, `@import`,
`url(http…)`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
`sendBeacon`, `importScripts`, dynamic `import()`, `<link rel=stylesheet>` — is
`NETWORK_REFERENCE`, severity 1, emit blocked with no override. The runtime
source is itself written to contain none of those tokens, so it survives its own
scanner. `verify-offline.mjs` then proves the law at runtime in headless Chromium
with every request blocked.

**Why.** A literal grep would either be turned off (and then the law is a README
claim, which §18.4 explicitly forbids) or would ban inline SVG. Parsing keeps the
law absolute while making it survivable, and the runtime proof means the static
scan is a first line of defence rather than the only one.

---

## D11 — Studio and artifact CSS variable namespaces are disjoint by prefix

**Unsettled by:** §15 says a single shared CSS variable between studio chrome and
artifact output is a bug, without saying how that is prevented.

**Decision.** Studio chrome uses `--st-*` exclusively; artifact theming uses
`--pp-*` exclusively. A test asserts the two sets are disjoint and that neither
stylesheet references the other's prefix.

**Why.** It turns §15's rule into something a machine checks on every build,
which is what "is a bug" needs to mean in a codebase that eleven lanes write to.

---

## D12 — Canonical scroll position per beat

**Unsettled by:** §10 requires backward navigation to restore "the precise prior
visual state, including scroll and any transform", tested by state hash.

**Decision.** Scroll is a deterministic function of the beat, computed from the
first element that beat reveals, rather than a remembered scalar. Ad-hoc scrolling
during presentation is transient and is reset by any navigation.

**Why.** Remembering scroll makes the restored state depend on presentation
history, so a state hash after forward-then-back would only match if the presenter
had not touched the wheel. Deriving it makes reversibility exact by construction
and makes the §17.9 assertion meaningful. It also behaves better live: a beat
always frames its own reveal the same way, on every run of the deck.

---

## D13 — Repository placement

**Unsettled by:** the spec names repo slug `pitchproof` but the build was started
from a session rooted on an unrelated repository.

**Decision.** PitchProof lives in `Tyler-N-Douglass/PitchProof` with the spec's
`/src /test /scripts /dist` layout at the repository root. No PitchProof code
lives in, or is shared with, the ContentOps repository.

---

## D14 — The three W3C namespace URIs are permitted in artifact script, as exact whole strings only

**Unsettled by:** D10 permits `http://www.w3.org/2000/svg` and its siblings as
`xmlns` attribute values. The runtime also needs the SVG namespace as a string
argument to `createElementNS`, which D10 as written would reject.

**Decision.** The network scanner permits exactly three strings —
`http://www.w3.org/2000/svg`, `http://www.w3.org/1999/xlink`,
`http://www.w3.org/1999/xhtml` — anywhere in the emitted document, as whole
tokens. Any other occurrence of `http://` or `https://`, and any of these three
appearing as a prefix of a longer URL, remains `NETWORK_REFERENCE`, severity 1.

**Why.** They are namespace identifiers, not locations: no user agent has ever
resolved them, and `document.createElementNS` requires the literal. The
alternative — assembling the string from fragments so the scanner cannot see it
— would be evasion, and a law you evade in your own source is not a law. Naming
three exact strings keeps the rule absolute for everything else, and the runtime
proof in `verify-offline.mjs` still has to pass with every request blocked.

---

## D15 — The automatic exit at the end of a branch is reversible

**Unsettled by:** §11 requires a branch to exit to its anchor or the next spine
scene; §10 requires backward navigation to be exact, and §17.9 asserts a state
hash after forward-then-back equals the original for every beat of every scene.
The two collide at the last beat of a branch: advancing exits the branch, and
stepping back would land on the previous spine scene rather than back inside it.

**Decision.** Advancing past the last beat of a branch returns, and records
`exitedFrom` in the navigation state. The very next backward step re-enters the
branch at the beat it was left, restoring the popped frame. Every other
transition clears the marker, and an explicit `return`/`r` does not set it —
that is a decision, not an accident. `exitedFrom` is deliberately excluded from
`stateHash`, which is a digest of what is on screen.

**Why.** Without it, one keypress at the end of a branch puts the branch
permanently behind the presenter, and the §17.9 assertion is simply false for
every branch-terminal beat. The alternative reading — that a branch's last beat
should not auto-advance at all — protects the invariant by stranding the
presenter, which is exactly the §22.4 failure. Making the exit reversible keeps
"space always moves forward" *and* "back always undoes what forward just did".

---

## D16 — Presenter view is a directly written second window, not a channel

**Unsettled by:** §12 requires presenter view to open "in a second window" and
the artifact to work from `file://`, from a USB stick, and from an email
attachment (§13).

**Decision.** The presenter window is opened with no URL and its document is
written directly by the parent, which then renders into it and listens to it.
There is no `BroadcastChannel`, no `postMessage` protocol, and no second copy of
the state.

**Why.** A `file://` document has an opaque origin, so a channel between two
windows is not reliably available — and a presenter view that works on a
developer's local server and fails on the client's laptop is worse than none.
Writing the document directly needs no origin at all, keeps one source of truth
for the state, and adds nothing to the emitted bytes that the scanner has to
forgive.

---

## D17 — Cross-lane integration is frozen in `API.md`

**Unsettled by:** §19 says lanes communicate "through the frozen contracts",
which cover the data model but not the function surfaces lanes call on each
other.

**Decision.** `API.md` declares the exact module path, export name and signature
of every surface a lane may rely on, for L1 and L2 (already built) and for each
of L3–L12 (to be built). A lane exports exactly what is declared and imports
nothing else from another lane.

**Why.** Nine lanes are written in parallel against code that does not exist
yet. The §4 contracts settle what a `Specimen` is, but not what to call to get
one. Without a declared function surface each lane invents its own, and
integration becomes a rewrite. Declaring it up front costs one document and
makes the fan-out actually parallel.

---

## D18 — The reversible branch exit records the whole unwound stack, not the top frame

**Unsettled by:** D15 made the automatic exit at the end of a branch reversible
by recording `exitedFrom`. It did not say what to record, and recording the top
return frame is the obvious reading.

**Decision.** `exitedFrom.stack` holds the entire return stack as it stood
inside the branch, and stepping back restores it wholesale. `checkInvariants`
additionally asserts that `stack[0].sequenceId` is the spine.

**Why.** The obvious reading is wrong, and wrong in the way §22.4 warns about.
`returnPolicy: 'anchor'` pops one frame, so a single-frame record round-trips.
`'nextSpineScene'` unwinds the whole stack, so restoring one frame leaves the
stack floored on a branch. That state passes every other invariant and throws
one action later: the presenter presses back, then `r`, and the deck stops
responding in front of the client. `unwindToNextSpineScene` already computed
from `stack[0]` on the assumption that the floor is the spine, so the assumption
was load-bearing and unchecked — it is now checked.

Found by L9's return-stack property test, which reached the state in 342 of 1000
mixed walks and 7 of 200 anchored-only walks. Five keystrokes reproduce it:
`goToScene → jump A → jump B → space → back → r`. The fix changes no contract
and no rendered state — `exitedFrom` is excluded from `stateHash` — and is
pinned by `test/runtime/nav.test.mjs`.

This is the argument for property testing a navigation machine rather than
enumerating its cases: the defect needed a `nextSpineScene` branch entered from
inside another branch, which no unit test I wrote thought to construct.

---

## D19 — The artifact is bundled from a composition root, not from the runtime

**Unsettled by:** §19 gives L2 the runtime, L8 the layouts and L9 the branches,
and §5 says the runtime bundle is inlined into every artifact. Nothing says who
puts the three together.

**Decision.** `src/artifact.js` is the composition root and is the entry
`scripts/build.mjs` bundles into `dist/pitchproof-runtime.js`. It re-exports the
runtime's whole surface, calls `registerAllLayouts()` at module evaluation, and
its `boot` wires `registerBranchOverlays` and `installBranchInputBridge` onto
the runtime it creates. It belongs to no lane. The exported global stays
`PitchProofRuntime` and `boot` keeps its signature, so the emitter needed no
change.

**Why.** The layering is right and the gap it leaves is invisible to every lane.
`src/runtime/**` must not import `src/scene/**` or `src/branch/**` — both depend
on the runtime, so the runtime cannot depend on them — which means a bundle
built from `src/runtime/index.js` contains no layouts and no overlays. The
emitted artifact still *looked* correct, because the emitter pre-renders the
opening beat as static HTML for the cold-boot budget. The presenter's first
keypress made the runtime re-render, find no layout registered, and replace the
client's own content with "Layout not registered"; `/`, `m` and `c` opened
nothing. Every lane's suite was green, and the end-to-end artifact test passed
too, because it only asserted that the opening scene was non-blank.

The seam is now asserted directly: the integration test navigates and then
requires zero placeholders and all three overlays to open and close.

---

## D20 — Lane decisions live in `docs/decisions/`, indexed from here

**Unsettled by:** §23 requires every judgment call the spec did not settle to be
recorded with its rationale. With twelve lanes writing in parallel, a single
appended file would have been a merge conflict on every commit.

**Decision.** Each lane filed its own `docs/decisions/L<n>-*.md` in full. This
file keeps the cross-cutting decisions (D1–D19, which govern more than one lane)
and indexes the rest rather than copying them.

| Lane | Document | Entries |
|---|---|---|
| L4 Brand colour | `docs/decisions/L4-color.md` | 17 |
| L5 Brand type/logo/shape | `docs/decisions/L5-type-logo-shape.md` | 23 |
| L6 Specimen | `docs/decisions/L6-specimen.md` | 16 |
| L7 Recipes | `docs/decisions/L7-recipes.md` | 16 |
| L8 Scenes | `docs/decisions/L8-scenes.md` | 21 |
| L9 Branches | `docs/decisions/L9-branches.md` | 12 |
| L3 Ingest | `docs/decisions/L3-ingest.md` | 20 |
| L10 Emitter | `docs/decisions/L10-emit.md` | 23 |
| L11 Validate | `docs/decisions/L11-validate.md` | 14 |
| L12 Studio UI | `docs/decisions/L12-ui.md` | 13 |

175 lane decisions in total, alongside the 23 cross-cutting ones here.

**Why.** A lane's reasoning is most useful next to the code it explains, and
flattening six documents into one would have lost the attribution that makes a
decision reviewable — the §20 critic needs to know *who* decided something and
against what evidence, not just that it was decided.

---

## D21 — While a text field has focus, the runtime keeps only Escape

**Unsettled by:** §12 gives `/` the jump index and arrow keys the deck, and does
not say what an arrow key means while the jump search has focus.

**Decision.** `resolveKey` returns nothing while `typing` is true unless the
binding is marked `whileTyping`, which is Escape and nothing else. The arrows,
Enter and Tab belong to whatever control the field drives.

**Why.** The original set let `ArrowUp`/`ArrowDown` through "for the list the
field drives" — but the keymap then resolved them to `prevScene`/`nextScene`, so
arrowing through the jump results also walked the presentation behind the
overlay while the presenter was still typing. L9 filed it as a dispute against
this file and defended against it in the capture phase; that interception is now
the outer of two defences rather than the only one. A presenter searching for an
objection must not be moving the deck the room is looking at.

---

## D22 — Form state is a property, and the caret is carried across a repaint

**Unsettled by:** D4 makes the renderer a VNode tree with `mount()` replacing the
subtree. Nothing said what happens to a focused form control when the tree
re-renders under it.

**Decision.** `toDom` sets `value`, `checked`, `selected` and `indeterminate` as
DOM **properties** as well as attributes, and `RuntimeHost.paint()` captures the
focused text entry's value and selection before `mount()` and restores them
after. When the value round-trips unchanged the exact selection is restored;
when the model deliberately changed the value, the caret goes to the end of the
new value rather than to a stale offset.

**Why.** On a form control the attribute sets the *default* value and the
property holds the live one, so a re-rendered search field showed the right text
with its caret at zero. The jump index re-renders on every keystroke, so each
character landed in front of the last: a presenter typing `appr` produced
`rppa`, and §11's "types three characters of 'approvals' and lands in the
approval-chain branch in under a second" matched nothing at all.

Found by `scripts/verify-offline.mjs` driving a real emitted artifact with a
real keyboard — no unit test would have caught it, because every lane's tests
render once and assert the output. L10 diagnosed it precisely and reported it
across lanes rather than working around it; the root cause was in L1's `vdom.js`
and L2's `host.js`, so it was fixed there rather than papered over in the
overlay.

The general lesson is in the mechanism: a renderer that rebuilds a subtree
destroys anything the DOM was holding that the model does not describe —
selection, scroll, focus, composition state. Selection is the one that mattered
here; `focusOverlay` already handled focus, and scroll is derived per beat by
D12.

---

## D23 — The build is a part, and it needs its own test

**Unsettled by:** §17 lists ten golden tests, all of them about behaviour of the
source. None is about the artifact the build produces.

**Decision.** `test/integration/studio.test.mjs` opens the built
`dist/pitchproof-studio.html` in a browser and asserts it parses, mounts,
reaches no network, loads no font, keeps `--pp-*` out of its own stylesheet, and
carries exactly one document. `test/integration/artifact.test.mjs` does the same
for an emitted proof.

**Why.** The studio was broken and 1608 tests were green. `scripts/build.mjs`
filled its template markers with `String.replace` and a *string* replacement,
which expands `$'`, `$&` and `` $` ``. Three bundled sources legitimately
contain those sequences — character tables in `core/text-metrics.js` and
`emit/scan-parse.js` hold a literal `'$'`, and `runtime/host.js` holds `'\$&'`
in `cssEscape` — so each `$'` spliced the whole remainder of the document into
the middle of a string literal. The file parsed with a syntax error,
`PitchProofStudio` was never defined, and the studio rendered its own "bundle
did not load" fallback. It also inflated the file from 2.8 MB to 4.4 MB, which
nothing noticed either.

Every lane tested its own source and the integration tests tested an emitted
artifact. Nothing opened the primary deliverable. §1 calls the studio "a
single-file, Netlify-deployable HTML application"; the test now asserts the file
that would be deployed actually runs.

Two smaller lessons came out of writing it, both worth keeping. Assertions about
a bundle must be made against the **parsed document**, not against the file
text: three of my first attempts flagged the studio's own source code, because
the bundle legitimately contains `<html>`, `<style>` and `@font-face` inside
JavaScript string literals — the emitter builds documents for a living. And an
`iframe` is not a network reference: the live preview uses one with no `src` and
no `srcdoc`, written into directly like the presenter window (D16), which is
what keeps the artifact's `--pp-*` theme out of the studio's `--st-*` chrome.

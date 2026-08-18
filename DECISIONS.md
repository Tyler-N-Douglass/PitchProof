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

# L10 Emitter — decisions

Judgment calls the spec did not settle, in the style of `DECISIONS.md`. Nothing
here overrides `PITCHPROOF-BUILD-SPEC-v1.0.md`, `API.md`, or `DECISIONS.md`.

Lane scope: `src/emit/**`, `test/emit/**`, `test/fixtures/emit/**`,
`scripts/verify-offline.mjs`.

---

## The artifact document structure

L12 and the §20 critic need one description of what comes out of `emit()`.
`test/emit/emit.test.mjs` asserts every marker below and their order, so this
section cannot drift from the file.

```html
<!doctype html>
<html lang="{first specimen locale, else en}" data-pp-artifact="1">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>{prospectName}</title>
  <style id="pp-runtime-css">   … dist/pitchproof-runtime.css …            </style>
  <style id="pp-font-css">      … @font-face, licence-asserted faces only … </style>
  <style id="pp-theme-css">     … --pp-* from the brand system …           </style>
  <style id="pp-user-css">      … the user's own CSS, applied last …       </style>
</head>
<body>
  <div id="pp-stage-root" data-pp-prerendered> … THE OPENING BEAT, AS HTML … </div>
  <noscript><p class="pp-noscript">…</p></noscript>
  <script id="pp-model"    type="application/octet-stream">{base64 payload}</script>
  <script id="pp-media"    type="application/octet-stream">{one entry per line: a data: URI,
                                                            or `@src` for one the opening beat
                                                            already carries — see E31}</script>
  <script id="pp-manifest" type="application/json">{generator, schemaVersion, proofId, compression}</script>
  <script id="pp-runtime">  … the bundled artifact runtime (src/artifact.js) … </script>
  <script id="pp-boot">     … decode + PitchProofRuntime.boot(…) …            </script>
</body>
</html>
```

The order **is** the §12 cold-boot budget written as markup:

1. Styles are inline, so there is no stylesheet to wait for.
2. `#pp-stage-root` carries the opening beat **already rendered as static
   HTML**, marked `data-pp-prerendered`. This is the paint, and it happens
   before a line of JavaScript has run. `RuntimeHost.attach()` sees the
   attribute and adopts the markup rather than replacing it, so the artifact
   never flashes.
3. The payloads sit *after* the stage root, so nothing about them delays the
   paint. They are inert: a `<script>` with a non-executable type is data. A
   media entry the opening beat already paints is a back-reference rather than a
   second copy of the picture (E31): the lending element carries
   `data-pp-m="<line index>"` and the line names the attribute to read it from.
4. The runtime, then the boot script, which reassembles the model and makes the
   keyboard work.

Those five `<script>` elements are the only ones an artifact may contain, and
`scanForeignScripts` refuses a sixth (E33).

Measured on the fixture proof, from `file://` in headless Chromium with the
network blocked: **first contentful paint 80–88ms against the 1500ms budget**.

`window.__PITCHPROOF__ = {runtime, host, version, ready}` is set once boot
completes, and `<html data-pp-ready="true">` with it. Both exist so
`scripts/verify-offline.mjs` can wait for boot and cross-check the deck; neither
reaches the network and neither is required for the artifact to work.

---

## E1 — A severity-1 finding returns `err`, not `ok` with findings

**Unsettled by:** API.md types `emit` as `Promise<Result<EmitResult>>` and
annotates `EmitResult.findings` with "severity 1 present => emit refused",
without saying which side of the `Result` a refusal lands on.

**Decision.** A refusal is `err(message, detail)`. The message names every
blocking finding with its code and locus and ends with "There is no override
flag (§14)". `detail` is the full `EmitResult` shape with `html: ''` and
`bytes: 0`, so the findings and the compression measurements are still
available for the studio to render.

**Why.** `ok` with findings makes refusal something a caller has to remember to
check. Every caller checks `result.ok`; not every caller checks
`result.value.findings.some(f => f.severity === 1)`. §14 says severity-1
findings block emit, and the type should make forgetting impossible rather than
merely discouraged. `html: ''` is the same argument at the byte level: there is
no partially-acceptable artifact to accidentally write to disk.

---

## E2 — The clock never reaches the artifact

**Unsettled by:** §5 requires two emits of the same project to be
byte-identical; API.md injects `deps.clock`; §6 asks for `STALE_CAPTURE` "at
emit time".

**Decision.** No wall-clock value is written into the artifact — no emitted-at
timestamp, no build date. `deps.clock()` is read in exactly one place, the §6
staleness check, whose output is a `Finding` and never a byte of the file.

**Why.** With a timestamp in the file, byte-identical re-emit is true only when
the clock is held still, which makes §17.6 an assertion about the test harness
rather than about the product. Without one it is unconditional: two emits an
hour apart are the same file. Nothing is lost — the proof already carries
`createdAt`, and the artifact has no use for the moment it was written.
`test/emit/determinism.test.mjs` emits the same proof with clocks five years
apart and asserts the bytes are identical.

---

## E3 — The model payload is base64 in both variants

**Unsettled by:** D6 splits media out of the compressed payload but does not say
how the uncompressed variant is encoded.

**Decision.** The model payload is base64 whether it is compressed or not:
`base64(deflateRaw(utf8(json)))` or `base64(utf8(json))`.

**Why.** Raw JSON in the document would put the prospect's own `sourceUrl`
strings, `cta` hrefs and `meta` values into the file as literal text — and the
network scanner cannot tell a URL that is data from a URL that is a
destination. It would either fail every real proof or need an exemption for a
whole region of the document, and an exemption that large is how §18.4's law
stops being verifiable. Base64 removes the question: `://` cannot occur in the
base64 alphabet, so the payload is provably inert to the scanner without
anything being excused. The cost is 1.333×, and the uncompressed variant only
wins when the payload is small enough for that not to matter.

**Measured.** Fixture proof: model 12,876 bytes raw → 3,688 compressed.

---

## E4 — The compression comparison counts the decoder

**Unsettled by:** §13 says "measure and keep whichever is smaller"; D5 says the
artifact inflates with the platform `DecompressionStream`, "which costs no
bytes".

**Decision.** The compressed variant carries a complete raw-INFLATE
implementation as a fallback for engines without `DecompressionStream`, and
those bytes are counted against it in the comparison. The uncompressed variant
does not carry it at all. `EmitResult.measured` reports both variants as
`{mode, payloadBytes, bootBytes, totalBytes}`.

**Why.** D5's "costs no bytes" is true only if nothing is shipped for the
engines that lack the API — Safari before 16.4, Firefox before 113 — and §13
requires the file to open when it is forwarded as an email attachment and
double-clicked on whatever machine receives it. Once the fallback ships, its
bytes are part of what compression costs, and measuring only the payload would
not be measuring. The fallback handles all three DEFLATE block types, stored
included; `test/emit/compression.test.mjs` builds stored-block streams by hand
so that path is proved rather than assumed, and `scripts/verify-offline.mjs`
loads the real artifact a second time with `DecompressionStream` deleted.

**Measured.** The fallback inflater costs 6,380 bytes. On the fixture proof the
compressed variant totals 14,934 bytes against the raw variant's 17,742, so
compression wins; on a single-scene proof with no specimens the raw variant wins
(8,678 against 12,774) and no inflater is emitted. Ties go to `raw`: an artifact
that needs no decoder starts a millisecond sooner and has one fewer thing that
can fail.

---

## E5 — Only base64 media leaves the model; text media stays inside it

**Unsettled by:** D6 divides "media" from "the model" without saying which side
an SVG written as `data:image/svg+xml,<svg…>` falls on.

**Decision.** A data URI is moved to the media table only when it is `;base64`
and at least 64 bytes long. Everything else — text data URIs, short URIs, inline
SVG markup in a `LogoAsset` — stays in the model payload.

**Why.** Two reasons, and they agree. D6's argument is about double base64
expansion, which only applies to data that is already base64; text compresses
four to six times over and belongs inside. And a media table holding only base64
can never contain a character sequence that ends the `<script>` element carrying
it, which removes an escaping problem entirely rather than solving it.
`test/emit/compression.test.mjs` asserts the table contains no `<` at all.

---

## E6 — Every scene is scanned, not only the document

**Unsettled by:** §13 says to "scan the final output"; API.md types
`scanForNetworkReferences(html)`.

**Decision.** `emit()` scans the finished document *and* separately scans the
serialized HTML of every scene in the spine and every branch, with the scene id
in the locus.

**Why.** Only the opening beat is in the document. Scenes 2..n exist as a
compressed model payload and are rendered at presentation time, so a scan of the
file alone would leave almost the whole proof unchecked — a tracking pixel on
scene 7 would pass. Scanning the rendered trees closes that, and it is what
makes the law cover the artifact rather than the file.

---

## E7 — A model asset that is not inlined is a `NETWORK_REFERENCE`

**Unsettled by:** §4 documents `MediaRef.dataUri` as "always inlined by emit
time" but names no finding for a model where it is not.

**Decision.** `scanModelAssets(proof)` reports any `MediaRef.dataUri` or
`LogoAsset.data` that is not a `data:` URI as `NETWORK_REFERENCE`, severity 1,
with the asset id in the locus. A logo given as inline SVG markup is run through
the full document scanner, so a sanitised-away `<image href="https://…">` is
reported against the logo rather than silently removed.

**Why.** Found in integration: a `MediaRef` pointing at `https://cdn.example/…`
is correctly kept out of the artifact by a layout that renders only `data:`
sources — and then *nothing is reported*, so a hero image vanishes from the
proof and the seller finds out in the room. §13 says degradation is never
silent and §20 axis 9 scores exactly that. `NETWORK_REFERENCE` rather than
`ASSET_MISSING` because the model is not missing an asset, it is asking the
artifact to fetch one.

**Deliberately not flagged, because neither is an instruction to fetch:**

- `Specimen.sourceUrl`, `BrandSystem.sourceUrl`, and a `cta` block's `href`.
  These record where the prospect's own content came from. They render as text
  or as nothing, and no user agent resolves them. If a layout turns one into a
  live `<a href>`, the per-scene document scan catches it — and does
  (`test/emit/scanner.test.mjs`).
- A `raw` content block that was never opted in. §8 requires a per-specimen
  opt-in before raw HTML is presented at all, so an un-opted block is not part
  of the artifact. Opted in and rendered, the per-scene scan sees it.

---

## E8 — URLs in visible text are not network references

**Unsettled by:** §13's literal instruction to scan for `http://` and `https://`.

**Decision.** The scanner reads attributes, CSS, and executable script. It does
not read text nodes, `<title>`, or `<textarea>` content — nor, per **E23**, the
closed set of attributes that hold prose rather than references.

**Why.** The artifact presents the prospect's own content, and that content says
`northwind.example` all over it. A browser never fetches a text node. A scanner
that failed on one would be switched off within a day, and §18.4 explicitly
forbids the law becoming a README claim. Inside script, comments are masked
before the URL scan for the same reason: a URL nobody can reach is not a
reference, and failing on the comment that documents the law would put the law
at war with its own documentation.

---

## E9 — Dynamic code evaluation is treated as a network reference

**Unsettled by:** §13 lists fetch/XHR/WebSocket constructors; D10 extends the
list; neither names `eval` or `new Function`.

**Decision.** `eval(…)` and `new Function(…)` in executable artifact script are
`NETWORK_REFERENCE`, severity 1.

**Why.** §13 exempts "inert string literals" from the constructor rules, and
that exemption is sound exactly as long as string literals stay inert. `eval`
and `new Function` are what make a string executable, so they are the one
construct that turns the exemption into an escape hatch. `NETWORK_REFERENCE` is
used because `FindingCode` is frozen (§4) and no other code fits; the message
says what was actually found. The runtime, the boot source and the studio bundle
all contain neither.

---

## E10 — `labelIllustrativeContent: false` on a review-reachable build refuses the emit

**Unsettled by:** §9 says the flag "cannot be disabled for Review-mode builds";
`normalizeEmitOptions` forces it true. Nothing says whether the *request* should
be refused or quietly overridden.

**Decision.** Both. `normalizeEmitOptions` forces the flag true, so nothing
unlabelled can ship even if the check below were deleted — and if the caller
explicitly passed `false` for a build whose mode is `review` or `both`, **and**
the proof carries at least one rendition that would need a label, `emit()`
refuses with `PROVENANCE_UNLABELED` at severity 1.

**Why.** Silently overriding an explicit instruction and shipping anyway teaches
the user nothing about the law they just ran into, and leaves them believing
their setting took effect. Refusing says what happened. The "at least one
rendition would need a label" condition keeps it from being gratuitous: a proof
with no illustrative content has nothing the flag could have hidden, and
refusing an honest artifact over a setting with no effect would be theatre.

For `mode: 'presenter'` the flag may still be disabled, because §9 scopes its
prohibition to Review builds — see `docs/disputes/L10-emit.md`, which records
why §18.1's "always" and §9's "for Review-mode builds" are in tension and why
the emitter follows the more specific rule.

---

## E11 — A rendition a layout does not render needs no label

**Unsettled by:** §9 requires a label on any rendition that is not
client-supplied. API.md tells L8 that "every illustrative rendition a layout
renders must carry an element with class `pp-provenance` inside the same
subtree". Neither says what happens when a layout *selects*.

**Decision.** The requirement is scoped to what the scene actually put on
screen. A rendition with a `data-pp-rendition` subtree must carry a label inside
it. A rendition with no such subtree is required to be labelled only if its own
content — its label text, one of its block text runs, or one of its media data
URIs — appears in the rendered tree.

**Why.** `quoteCard` pulls one quotation out of a scene's renditions and shows
only that; `sideNote` shows one note. Demanding a label for a rendition that is
not on screen would refuse a perfectly honest proof. The check is content-based
rather than declaration-based on purpose: reading only `data-pp-rendition` would
let a layout render illustrative content and escape the law simply by not
declaring it. `test/emit/provenance.test.mjs` attack 16 plants exactly that.

A rendition may also be rendered by more than one element in a scene —
`splitBeforeAfter` puts `data-pp-rendition` on the panel head *and* on each body
cell, and the label lives in the head. The subtrees are unioned. Letting the
last one seen decide reported a correctly labelled proof as bare, which is how
this was found.

---

## E12 — Presenter notes are removed from a Review build, not hidden

**Unsettled by:** §2 says Review mode has "no presenter notes"; §12 makes
presenter view an explicit toggle. Nothing says whether the notes travel in the
file.

**Decision.** When `emitOptions.includePresenterNotes` is false — which
`normalizeEmitOptions` forces for `mode: 'review'` — every `Beat.presenterNote`
is set to `null` before the model is encoded.

**Why.** The runtime already refuses to open presenter view without notes, so
they are unreachable through the UI. They are not unreachable from the file: the
payload is base64 of DEFLATE, which anyone can decode. Presenter notes are where
the internal read on the room lives — who the blocker is, what not to say — and
a Review build is by definition the file that gets forwarded. `test/emit/emit.test.mjs`
decodes the emitted payload and asserts the notes are gone, rather than merely
absent from the markup.

---

## E13 — The size budget is met by really re-encoding, and PNG is re-encoded in-repo

**Unsettled by:** §13 requires progressive downscaling and an exact report of
what was degraded. There is no canvas in Node and D3 rules out an npm decoder.

**Decision.** `src/emit/png.js` is a dependency-free PNG codec: decode
(non-interlaced, bit depths 8 and 16, colour types 0/2/3/4/6), area-average
resample, re-encode as 8-bit RGB or RGBA with per-row adaptive filtering and the
repo's own DEFLATE. SVG and text data URIs are minified. Formats the codec
cannot re-encode — JPEG, WebP, AVIF, interlaced PNG — are degraded only through
an optional `deps.resample` hook the host can supply (the studio has a canvas);
without one they are reported as undegradable, by id and by reason, and if the
budget still cannot be met `emit()` raises `SIZE_BUDGET_EXCEEDED`.

**Why.** A report of bytes saved is honest only if the bytes were saved, so the
emitter has to do the work rather than estimate it. PNG is where an oversized
artifact actually comes from — screenshots and logos — and it is the one format
that can be decoded and re-encoded losslessly in a few hundred deterministic
lines. Implementing a JPEG codec is a second product; pretending to downscale a
JPEG would be worse than saying it cannot be done.

**Measured.** Fixture proof at 220px assets, budget cut to 80% of the full
artifact: three assets resampled to 50%, 229,096 bytes saved, every line's
`savedBytes` equal to `beforeBytes - afterBytes` exactly.

---

## E14 — `SIZE_BUDGET_EXCEEDED` is severity 1

**Unsettled by:** §4's `FIXED_SEVERITY` pins `PROVENANCE_UNLABELED`,
`NETWORK_REFERENCE` and `STALE_CAPTURE`, and leaves `SIZE_BUDGET_EXCEEDED` open.

**Decision.** Severity 1. The emit is refused. This is the one code the gate
(E24) does not run, because the emitter has measured what the rule can only
estimate.

**Why.** §22.5: "a 60MB artifact that takes eleven seconds to open is a failed
artifact." A warning the caller can walk past is exactly the silent partial emit
§13 forbids — the seller gets a file, it opens badly in front of the client, and
nothing stopped it. The refusal names the assets that could not be degraded and
what to do about them (`deps.resample`, or capture smaller).

---

## E15 — Importance rank is derived from the rendered scenes, not declared

**Unsettled by:** §13 says to rank by "presentation importance (spine before
branch, revealed-early before revealed-late)" without saying how the emitter
learns where an asset appears.

**Decision.** The budgeter renders every scene, finds the element carrying each
asset, walks up to the nearest `data-pp-el` ancestor, and reads the beat that
first reveals it. Rank keys, in order: sequence (spine before branch), scene
index, beat index, kind (logo, then a specimen's first media, then the rest),
then model order as a deterministic tiebreak.

**Why.** "Revealed-early before revealed-late" has no meaning unless something
knows which beat reveals which asset, and nobody hand-labels that. Rendering is
the only source of truth, and the emitter is rendering anyway for the first
paint and the provenance check.

**Consequence, asserted:** degradation is monotonic in rank. The allocator
always spends the least important asset that still has a ladder step, so the
number of steps applied never decreases as rank increases. The logo on the
opening beat is the last thing to lose pixels.

---

## E23 — An accessible name is text, not a reference

**Unsettled by:** D10 classifies `src`/`href` and leaves every other attribute
to the emitter's judgement. E8 settled that a URL in visible text is not a
reference, and said nothing about a URL in `aria-label`.

**Decision.** A closed, named set of attributes is classified as prose and
exempt from the absolute-URL catch-all: `alt`, `title`, `label`, `placeholder`,
`download`, `abbr`, `aria-label`, `aria-description`, `aria-placeholder`,
`aria-roledescription`, `aria-valuetext`, `aria-keyshortcuts`
(`TEXT_ATTRS` in `src/emit/scan.js`). No finding at any severity, exactly as for
a text node. Everything else is untouched: every attribute in `URL_ATTRS` and
`SRCSET_ATTRS`, every `data-*`, `style`, every `on*` handler, `<meta content>`,
and every URL inside CSS or JavaScript stay as strict as D10 makes them.

**Why.** E8's argument is that a browser never fetches a text node and the
artifact presents the prospect's own content, which says their domain all over
it. An accessible name is that same information delivered to a different sense —
a screen reader reads `aria-label` aloud exactly as a sighted viewer reads the
paragraph beside it. Treating one as prose and the other as a reference was an
inconsistency in the scanner, not a policy, and it had a cost: L8 writes the
accessible name for a `systemMap` as "…flowing through https://… to 1 output",
and the corpus proof could not be emitted. The same URL passed in a `<p>` and
refused the emit as the alt text for the same diagram, with no override. A rule
that makes the accessible version of a scene less emittable than the
inaccessible one is a rule that gets layouts stripped of their alt text.

Severity 2 with an explanation was the alternative. It was rejected for the same
reason: reporting the accessible copy and staying silent on the identical body
text reintroduces the inconsistency one notch quieter, and a warning on every
scene that names its source trains people to ignore findings.

The set is closed and every member is a string the HTML specification defines as
human-readable text that no user agent resolves. `test/emit/scanner.test.mjs`
asserts both halves: a URL in each of them passes, and the same URL in ten
fetching attributes, in `data-*`, in `style`, in an event handler, in CSS, in a
JS literal and in `<meta content>` still refuses.

---

## E24 — `emit()` runs the whole §14 sweep, not only the laws it owns

**Unsettled by:** §14 says "Severity 1 findings block emit. There is no override
flag." `API.md` Part 3 repeats it. Neither says *which* severity-1 findings, and
the emitter is not the lane that owns most of the rules.

**Decision.** `emit()` runs every rule in `src/validate/rules.js` — L11's rule
objects, not a second copy of them — against the artifact that is about to ship,
and refuses on any severity-1 result. `src/emit/gate.js` builds the same context
`runPreflight` builds. The one exception is `SIZE_BUDGET_EXCEEDED`, which
`runPreflight` must *estimate* because it runs before serialization and which
the emitter has *measured* by the time the gate runs; running the estimate too
would put two findings for one question in front of the user, less accurate one
first, and would raise a false alarm on every proof the budgeter successfully
fits.

**Why.** Until this existed, §14's sentence was false. The emitter enforced the
laws it owned — network references, provenance, model assets, the size budget,
the §4 contract — and let `TEXT_OVERFLOW` and `CONTRAST_FAIL` through. The
critic demonstrated it (F8): a proof whose body text measured below 4.5:1 emitted
cleanly at 532,712 bytes. The law survived in the shipped product only because
`src/ui/gate.js` runs preflight before enabling the button, which makes it a
property of one caller rather than a property of the artifact. §9's reasoning
about provenance — "enforce this in the emitter, not just in the UI" — applies
here word for word: a `.pitchproof.html` handed to a client must not depend on
which program produced it.

**How.** One call to `runPreflight`, with the artifact's own rendered scenes,
its final stylesheet and the document about to be written.

It was not always. The first version rebuilt preflight's context by hand —
measuring the deck, collecting rendered element ids, assembling the cross-lane
dependency object — because `validate/lane-emit.js` re-exported L10's scanner
through `emit/index.js`, and a direct call was a module cycle the bundler
refuses (D3). That workaround cost about a hundred lines and, on its first run,
a real defect: it forgot `renderedElementIds`, so half of `BEAT_EMPTY` was
silently inert. L10-D8 proposed the fix, L11 made it, and the workaround went
with the cycle. One sweep, one implementation, no second context that can drift
from the first.

**What the tests prove now.** Rule-for-rule equivalence became true by
construction the moment the gate became a single call, so asserting it would
prove nothing. `test/emit/gate.test.mjs` asserts the two things that are *not*
by construction: that `emit()` wires the artifact's own `html`, `css` and
`renderScene` into the sweep — each checked through a finding that can only
arise if that argument arrived — and that it filters exactly the one code it
answers itself.

**Two things the emitter still answers itself**, because the rules cannot:

- the **per-scene** network scan (E6). The rules scan `ctx.html`, which is the
  document, and the document is the opening beat; scenes 2..n exist only in the
  model payload.
- §9's **label-option** check (E10). `normalizeEmitOptions` forces
  `labelIllustrativeContent` back to true before the model is serialized, so by
  the time the rule reads `proof.emitOptions` the evidence of the request is
  gone. L11's rule skips L10's copy of that finding precisely so there is one of
  it, and only the emitter still knows it was asked for.

---

## E28 — A degraded `MediaRef` reports its inlined cost

**Unsettled by:** §4 declares `MediaRef.bytes` without saying whether it counts
the decoded payload or the inlined data URI.

**Decision.** It is the inlined cost, `utf8Length(dataUri)`, which is L6's
settled meaning, and `applyReplacements` writes that after degrading an asset —
`hit.bytes`, which `degradeAsset` already measures that way.

**Why.** The first version wrote `parseDataUri(uri).bytes`, the decoded size,
which is about 25% smaller than the inlined cost. Nothing at emit time read it —
the budgeter measures its own — so nothing broke. But a seller looking at a
degraded asset in the studio would see a size a third short for the one asset
the product had just told them it shrank, which is the opposite of §13's "report
exactly what was degraded and by how much".

---

## E29 — An unreachable branch is reported, never dropped

**Unsettled by:** §11 raises `BRANCH_UNREACHABLE` for a branch with no anchor and
no jump-index entry, and does not say whether the emitter should carry it into
the artifact.

**Decision.** The emitter carries it. `BRANCH_UNREACHABLE` stays severity 2 and
the artifact ships with the branch in it, unreachable.

**Why.** L11 argued the case and it is right: an emitter that silently deletes
authored content is the worse failure. The seller gets a file missing an answer
they thought they had prepared, with nothing on screen telling them so — and
§13 requires the emitter to report even a recompression, so deleting whole
scenes deserves at least that much. Recorded here because it is the emitter that
would have done the deleting.

---

## E25 — One payload is one budgeting unit

**Unsettled by:** §13 says "compute the byte cost of every asset". It does not
say what to do when two assets are the same bytes.

**Decision.** `dedupeAssets` collapses assets by exact payload before ranking,
budgeting and reporting. The surviving entry keeps the earliest placement of any
reference and lists every id in `DegradationLine.assetIds`.

**Why.** `splitMedia` already deduplicates the media table by exact URI, so the
artifact pays for a shared payload **once**. Counting it per reference made the
budgeter believe the proof was larger than it is and degrade further than it
needed to — on the critic's corpus (F13) it produced 32 degradation lines for 15
distinct assets and emitted 11.1MB against a 13.5MB budget, throwing away
quality nobody asked it to spend. And a seller reading that report saw the same
image downscaled three times, at three different ranks, with identical from/to.
§13 requires reporting "exactly what was degraded and by how much"; three lines
for one degradation is not that.

---

## E26 — The degradation prediction is anchored to a measurement

**Unsettled by:** `API.md` gives `DegradationLine` both `predictedBytes` and
`actualBytes` without saying what the prediction is made from.

**Decision.** The prediction for a ladder step is computed from the **measured**
cost of the same image at the previous step, corrected for two things the naive
model ignored: the bytes a PNG spends before storing a pixel
(`PNG_CONTAINER_BYTES`), and base64 — 4 bytes per 3, plus the
`data:<mime>;base64,` prefix.

**Why.** The previous model was `bytes × scale²`. It looked reasonable on large
images and was out by 1200% at the bottom of the ladder, where a 30×18 thumbnail
is mostly container: it predicted 14 bytes for a file that came out at 182. A
`predictedBytes` with a median error of 1200% is worse than no prediction,
because it invites the reader to trust it. Anchoring to a measurement of the
*same picture* also tracks something no closed form knows: area-averaging noise
makes it compressible, so entropy changes as the image shrinks.

**Measured**, on the critic's corpus (15 × 600×400 noise PNGs, budgets from 90%
down to 45% of the full artifact): median error 9.4%, worst 21.5%, and every
line but one within 10% — against a previous median of 1200% and 13 of 32 lines
within 10%. `test/emit/budget.test.mjs` asserts a median at or below 25% and a
worst case at or below 100%, so the model cannot silently regress.

---

## E27 — The refusal collapses identical defects

**Unsettled by:** §14 requires the emit to be refused and gives no guidance on
how the caller is told.

**Decision.** Blocking findings with the same code and the same message are
collapsed into one entry carrying a count, the refusal opens with the shape of
the problem — how many findings, of which codes, in which scenes — and every
*distinct* defect is still stated in full.

**Why.** A five-rendition `splitBeforeAfter` scene produces eleven blocking
findings that are three distinct defects: the same body text is measured in
several cells and reported once per cell. Eleven near-identical paragraphs do
not tell a seller whether they have three problems or eleven, and the natural
conclusion — that the tool is broken — is the wrong one. Collapsing is not
hiding: a defect that occurs once appears once, and nothing is dropped. The cap
at twenty distinct entries reports how many were elided rather than trimming
silently.

**What this does not fix, and whose it is.** L11's individual overflow message
is good — it names the box, the breakpoint, the overage, the substituted face,
the unbreakable run and two remedies with numbers. What no message says is the
*cause*: that the scene has five renditions and `splitBeforeAfter` gives each of
them 101px at `md`. The seller's real remedy is fewer renditions or another
layout, and every message points at the text instead, which in this case is the
prospect's own compound noun and cannot be shortened. Naming the column count
needs the layout's own knowledge, so it belongs in L8's measurement or L11's
message, not in the emitter — recorded here and raised with the integrator.

---

## E16 — What the cascade evaluator does not do

`src/emit/css.js` resolves the cascade for a known element path: selectors and
combinators, specificity, `!important`, inline `style`, inheritance of the
properties that matter, custom properties and `var()`. It does not lay anything
out. Every limit below is stated in the direction that fails safe, and each is
asserted in `test/emit/css-cascade.test.mjs` so the code and this list cannot
drift.

| Limit | Direction | Why it is acceptable |
|---|---|---|
| No layout. A label pushed out of a scrolling container by its siblings, or covered by a later sibling with a higher `z-index`, is not detected. | Miss | Nothing in the runtime stylesheet does either, and `verify-offline.mjs` drives the real rendered artifact. |
| `:hover`, `:focus`, `:active` and the other interaction pseudo-classes are ignored. | Miss | A label hidden only while the mouse is over it is transient by definition. |
| `::before` / `::after` content is not counted as the label, and rules targeting them do not style the element. | Safe | Generated content is not a label; requiring a real node is stricter. |
| Every at-rule condition except `@media print`/`speech` is treated as applying. | False positive | A label hidden above 600px is a label hidden in the room. The cost is one CSS edit; the cost of the opposite error is §22.6. |
| Viewport units resolve against the smallest breakpoint (390×844). | Safe for a minimum-size check | A `font-size: 1vh` label is judged at its smallest rendering. |
| `clamp()` resolves to its floor. | Safe | A size floor has to be judged on the smallest size the rule can produce. |
| Markup inside a `raw()` VNode is opaque to the tree walk. | Safe | A label that exists only inside raw HTML counts as missing. |
| `color-mix()` mixes in sRGB regardless of the named space; `lab`/`lch` are not parsed. | Small error, both ways | Residual error is far below what a 4.5:1 threshold can notice; the runtime's only use is the overlay scrim. |
| A background image or gradient is not sampled; only a background *colour* counts. | Miss | A label on a photograph is a contrast question no static check can answer. Documented rather than approximated. |

The colour arithmetic is independent of `src/brand/color.js` on purpose. The
provenance law is severity 1 with no override, and a law is stronger when its
arithmetic is not shared with the subsystem whose output it is judging: if the
brand pipeline ever produced a wrong contrast number, an emitter that reused the
same function would agree with it. `test/emit/color-value.test.mjs` pins the
WCAG formulas to published reference pairs.

---

## E17 — Promotion records are read with L7's reader, not a second one

**Unsettled by:** API.md gives L7 `promoteProvenance` and says it "records a
promotion entry in `rendition.notes`", without publishing the format.

**Decision.** `src/emit/promotion.js` imports `hasPromotionRecord` and
`readPromotionRecord` from `../recipe/index.js` and adds only the emitter's
judgement on top: which renditions must carry a label, and which
`verified-by-user` claims were never earned.

**Why.** Two readers of one format is one reader too many. The moment they
disagree, the artifact ships either an unlabelled lie or a false refusal, and
neither lane would know which of them was wrong. L7's reader is also stricter
than a note-scraper can be: a record is bound to the id of the rendition it was
written for, so a record copied from one rendition onto another does not verify.
`test/emit/provenance.test.mjs` plants that copy and asserts it is caught.

---

## E18 — Layouts must be registered before `emit()`, and a missing one is an error, not a finding

**Unsettled by:** §4 freezes `FindingCode`, and none of the fourteen codes means
"this layout is not registered".

**Decision.** `emit()` checks every layout the proof uses and returns
`err(...)` naming the missing ones, with the instruction to call
`registerAllLayouts()` first. It does not invent a finding code.

**Why.** An artifact whose scenes render "Layout not registered" is not a proof,
and §4 forbids extending the closed set of codes. A `Result` error is the honest
carrier: it blocks, it explains, and it does not pretend to be a validation
finding L11 also knows about. In practice the integrator's composition root
(`src/artifact.js`) registers layouts at module evaluation, and
`test/emit/integration.test.mjs` emits through the real eight.

The artifact's boot script calls `registerAllLayouts()` and
`registerBranchOverlays()` defensively, guarded — and checks first whether the
overlays are already registered, because registering twice would install a
second controller whose render function replaces the first's while the input
bridge still holds the first. It also announces no change, since no overlay is
open at boot and a repaint would only discard the markup the emitter
pre-rendered.

---

## E19 — The emitter refuses content that would end its own element rather than escaping it

**Unsettled by:** §13 requires everything inline; nothing says what happens when
inlined code contains `</script>`.

**Decision.** `inlineRuntime` refuses, naming the offset. Script content is
checked for `</script` and `<!--`; style content for `</style`. A `</style>`
inside JavaScript is *not* refused.

**Why.** No single transform is safe in every position: `<\/script` is valid
inside a string literal and a syntax error inside a regular expression, so an
escaping pass would corrupt some inputs while fixing others. Refusing with an
offset is repairable; a corrupted artifact is not. The narrowness matters too —
the first version refused `</style>` inside a template literal and thereby
refused the presenter window (D16), which writes a whole document as a string.
The HTML tokenizer leaves script data only on `</script`, so that is what is
checked.

---

## E20 — `deps` accepts optional extras beyond the three declared

**Unsettled by:** API.md declares `deps` as `{runtimeJs, runtimeCss, clock}`.

**Decision.** Those three are required. `themeCss`, `userCss`, `fonts` and
`resample` are optional additions. `themeCss` takes L5's `compileTheme(brand).css`
when the caller has it; without it the emitter compiles the `--pp-*` variables
from the already-solved `ColorToken[]` itself (`src/emit/theme.js`), which needs
no colour science and duplicates nothing. `fonts` is the only route by which a
font is embedded, and only entries with `licenseAsserted: true` and a `data:`
URI are used (§7, §13).

**Why.** The artifact cannot ship without a theme — §15 says it wears the
prospect's brand, and §22.6's contrast check has to run against the stylesheet
the artifact will actually use. `userCss` exists because §22.6 requires the
label to survive "the *final* stylesheet, including any user CSS", which means
there has to be a way for user CSS to reach the emitter. Adding optional
parameters is the kind of extension API.md permits; the declared three still
produce a complete file on their own.

---

## E21 — The greedy allocator overshoots downward, and says so

**Unsettled by:** §13 asks for greedy allocation against `maxBytes` without
specifying granularity.

**Decision.** Degradation happens in whole ladder steps
(`1, 0.75, 0.5, 0.35, 0.25, 0.15`), so the result can land comfortably under the
budget rather than just under it. `emit()` re-budgets up to four times, each
pass refining the reserve — the bytes the document costs before assets — and
always measuring the plan against the **original** proof, never against the
previous pass's output.

**Why.** A finer ladder would preserve more quality but would multiply
re-encodes, and each one is a full decode-resample-encode. Landing under budget
is the requirement; landing exactly at it is not. Budgeting from the original
every pass is what keeps `savedBytes = beforeBytes - afterBytes` true of the
artifact that actually shipped: a plan measured against an already-degraded
proof would report savings relative to a state nobody ever saw.

---

## E22 — `verify-offline.mjs` compares the browser against an independent simulation

**Unsettled by:** §17.7 asks for "full keyboard walk of every scene and branch
completes"; §20.8 asks the critic to report "any state corruption". Neither says
what corruption is measured against.

**Decision.** Every key press is applied twice: to the real artifact in
Chromium, and to a pure `navigate()` simulation in Node. The browser's rendered
`data-pp-hash` is compared to `stateHash()` at every step. A divergence is
reported with the scene, the beat and both hashes, and the walk re-synchronises
so one divergence does not cascade into hundreds.

**Why.** "Completes without error" is a weak assertion — a deck that silently
lands on the wrong beat completes fine. Comparing against an independent
implementation of the same transition is what makes "state corruption" a
measurement instead of an impression. The walk covers every spine beat, a
backward step from every beat (§17.9 through the real keyboard), scene
navigation both ways, every branch by jump and back, a nested jump and its
unwind to an empty return stack (§22.4), the blank screen, all three overlays,
`Home`, and typing into the jump index (§11's "three characters of approvals").

The whole run happens twice: once normally, once with `DecompressionStream`
deleted before the document loads, so the fallback decode path is proved on the
real file. Requests are recorded by the context and every one that is not the
document itself is a failure; the context is offline and DNS is mapped to
nothing, so a request that got past the route handler still could not resolve.

**Measured, on the fixture proof:** 605,941 bytes, model compressed; 1 request
attempted (the document); 0 page errors; 0 console errors; first contentful
paint 80–88ms against 1500ms; 103 key presses over 21 deck positions with no
divergence, in both variants.

---

## E30 — The size budget counts the bytes the file has, not the bytes the model has (C2)

**Unsettled by:** §13 says "compute the byte cost of every asset" and §22.5 puts
a ceiling on the file. Neither says which of the two numbers "byte cost" is, and
they are not the same number.

**Decision.** An asset's cost is **`copies × utf8Length(dataUri)`, where `copies`
is counted in the document that was actually built**. `assetFootprint(html,
assets)` does the counting, and `emit()` calls it after every build:

```
reserveBytes + assetBytes === utf8Length(html)      always, by measurement
```

`reserveBytes` is therefore the document's real fixed cost — the runtime bundle,
the model payload, the stylesheet, the markup — and `maxBytes - reserveBytes` is
really what is left for pictures. The copy counts go to `budgetAssets` as
`options.copies`, so the greedy allocator stops when the *file* fits and every
`DegradationLine` carries what the *file* saved. `EmitResult.budget` publishes
all four numbers so a caller can check the arithmetic rather than trust it.

**Why.** The previous reserve was `built.bytes - Σ collectAssets(...).bytes`,
which is wrong twice over. `collectAssets` yields one entry per `MediaRef`, so a
picture a specimen and its rendition share was subtracted twice; and the
pre-rendered opening beat writes every payload it paints a second time, which
was not subtracted at all. On a corpus proof with a 1.34MB hero on scene 1:

```
                                    before        after
file                             3,070,806    1,743,322
reserve the emitter computed       386,602      403,738   (measured, not inferred)
true non-asset overhead            394,948      403,738
asset bytes the file spends      2,675,862    1,339,584
budget of exactly the file size    REFUSED          met
```

Three things rode on the bad number and all three were wrong. It **refused
budgets it could meet** — `maxBytes` equal to the artifact's own size came back
as a severity-1 `SIZE_BUDGET_EXCEEDED`. It **degraded further than it needed
to**, because the assets looked half their real size against a reserve that was
megabytes heavy. And the report a seller reads **understated the saving by
exactly the number of duplicated copies**, which on hero images is 2×. That last
one is the same defect as F13 in a different place: a report that is not about
the file.

Measured now, same proof, at five budgets (R = reserve, A = the natural asset
spend):

```
budget      maxBytes    file        reserve+assets   reported saved   actual saved
N          1,743,322   1,743,322    = file                    0              0
N-1        1,743,321   1,743,282    = file                   44             44
R+0.90A    1,609,363   1,078,654    = file              664,688        664,688
R+0.75A    1,408,426   1,078,654    = file              664,688        664,688
R+0.60A    1,207,488   1,078,654    = file              664,688        664,688
R+0.45A    1,006,550     709,162    = file            1,034,176      1,034,176
```

`test/emit/budget.test.mjs` asserts all of it against the emitted string — the
copy counts are recounted independently, and the model they are counted against
is decoded back out of the artifact rather than taken from the proof that went
in.

**What this deliberately does not do.** An asset the document never writes out
literally — anything `splitMedia` leaves in the model because it is shorter than
`MEDIA_PLACEHOLDER_FLOOR` or is not base64, such as `data:image/svg+xml,<svg…>` —
gets a copy count of **zero** and is not offered to the ladder. Its bytes are
real and they are counted, in the reserve, where they are. They are not a line
item because the emitter cannot measure a per-asset saving on them: they travel
inside the deflate stream, interleaved with the whole model, and a line claiming
such an asset gave back its full uncompressed length would be off by the
compression ratio. When the budget is missed, they are named in `undegradable`
with that reason rather than passed over in silence. Before this, they were
budgeted as if degrading them saved their entire literal length, which was the
same kind of fiction in the other direction.

---

## E31 — The opening beat's pictures are written into the file once (C2)

**Unsettled by:** §12 requires the first scene to be in the document as static
markup so it paints before JavaScript. D6 requires every payload in the media
table so the runtime can rebuild the model. Nothing says what to do when those
two requirements are about the same megabyte.

**Decision.** The markup keeps the payload — it has to, an `<img>` needs a real
`src` — and the media table borrows it back. `hoistFirstPaintMedia` marks the
lending element `data-pp-m="<table index>"` and writes `@src` (or `@poster`,
`@href`, `@data`) on that table line instead of the data URI.
`ppReadMediaTable` resolves those at boot, before the runtime touches the stage,
and throws if the markup cannot answer — a model still holding `@m7` where a
picture belongs would render a broken image and, on an engine that resolves it
as a relative URL, would put a network request in an artifact whose whole
promise is that it makes none.

**Why.** E30 makes the double-copy *reported* honestly. It does not make it
stop, and §13 spends one budget: an artifact carrying every hero image twice is
paying for the mistake as well as mis-reporting it. Measured:

```
proof                                   before        after      saving
corpus proof (real pipeline)           618,275      614,693       3,582
emitProof({imageEdge: 200}) fixture  1,018,828      804,176     214,652   (21.1%)
corpus proof with a 1.34MB hero      3,078,782    1,742,508   1,336,274   (43.4%)
```

The cost is `ppReadMediaTable` in the boot script, about 1.1KB, paid whether or
not anything is borrowed. It is paid back by the first picture on the first
scene, and the opening beat of a proof is a screenshot roughly always.

**Deliberate limits.** Only the *first* element to carry a payload lends it: two
`<img>` tags showing the same picture both need a real `src`, so the second copy
is a cost the markup genuinely has and `assetFootprint` charges it. Nothing
inside `<svg>` lends, because `getAttribute('xlink:href')` depends on how the
document was parsed and an artifact that cannot read one payload back has a hole
in its model. Nothing inside a `raw` VNode lends, because the emitter does not
know what element the payload sits on. In each of those cases the payload is
written twice and the budgeter says so.

**Proved where it matters.** `scripts/verify-offline.mjs` now reads the booted
runtime's model in real Chromium and asserts every `MediaRef.dataUri` is a
`data:` URI — 18 of 18 on the corpus artifact, in both the platform-decompression
and the no-`DecompressionStream` variant. The unit tests drive the artifact's own
`ppReadMediaTable` rather than a second implementation of it.

---

## E32 — The label's size floor is a measurement, not a list of declarations (C9)

**Unsettled by:** §18.1 says the label "cannot be styled to invisibility
(contrast and size floors enforced at emit)". It does not say what a size floor
is measured on.

**Decision.** `judgeLabelRoom` computes three things off the cascade and judges
those:

1. the **line box** the label's own `font-size` and `line-height` produce, and
   the tightest resolvable `height`/`max-height` on any element from `<html>`
   down to the label. A box shorter than one line **on an element that clips its
   own content** is the label hidden;
2. the tightest resolvable `width`/`max-width`, against a floor of
   `LABEL_MIN_WIDTH_EM` (6) times the font size, on the same condition;
3. **tracking** — `letter-spacing` and `word-spacing`, resolved to pixels
   against the size they apply at, floored at `LABEL_MIN_TRACKING_EM` (-0.1em).

And the §18.1 font floor is applied to the size the label is *painted* at:
`fontSizePx × Π(scale factors on the chain)`, reading `transform: scale…`, the
`scale` property and `zoom`.

**Why.** The first version answered a list: `display:none`, `visibility:hidden`,
`opacity:0`, `clip`, `clip-path`, off-screen position, `text-indent`,
`transform:scale(0)`, and `width`/`height` equal to the literal string `0`. It
refused thirteen of the §20 critic's eighteen stylesheets through both
`deps.userCss` and `deps.themeCss`, and two walked through:

```css
.pp-provenance{height:1px!important;overflow:hidden!important}   /* 313×22 → 313×6  */
.pp-provenance{letter-spacing:-1em!important}                    /* 313×22 → 19×22  */
```

Neither is a new idea. `height:1px` is `height:0` with a typo, and a list of
literal values is always one property behind whoever writes the stylesheet.
Measuring the box in pixels against the text that has to fit in it is a floor the
next spelling has to clear rather than avoid, and it subsumes `height:0`,
`max-height:0.2em`, `width:8px` and `scale(0.2)` without naming any of them.

**Where the line is drawn, and why.**

- **Clipping is judged on the element that declares the small box, never across
  the chain.** A one-pixel label inside a clipping stage still shows its text:
  the text spills out of the label, and the stage clips at the stage's own edge,
  which is nowhere near it. Pairing the two per element is what lets
  `.pp-provenance{height:1px}` alone pass — it is ugly, not invisible — while
  `.pp-provenance{height:1px;overflow:hidden}` is refused. The runtime's own
  `.pp-stage{overflow:hidden}` and `.pp-scene{overflow-x:hidden}` therefore
  cannot make every short box on the page an attack.
- **`overflow: auto` and `scroll` are not clipping.** A short scroll box leaves
  the label reachable. `hidden` and `clip` do not.
- **A dimension whose pixels depend on layout is not judged at all.**
  `resolveLengthPx` returns `null` for `%`, `auto`, `calc()` and the intrinsic
  keywords, and `null` means "this one says nothing", not "this one is fine".
  The emitter does not lay the document out, and a law resting on a guess is
  worse than no law. Viewport units resolve against the smallest breakpoint the
  product supports (390×844), which is the smallest the box can ever be.
- **-0.1em is the tracking floor** because real typography reaches about -0.05em
  on display sizes and stops. At -0.1em glyphs begin to touch; `-1em` stacks
  every character on the one before it.
- **6em is the width floor** because at the 11px font floor that is 66px, about
  eleven characters of a fifty-character sentence. A genuinely narrow column
  clears it; a nineteen-pixel smear does not.

`test/emit/provenance.test.mjs` asserts the two survivors are refused through
both `deps.userCss` and `deps.themeCss`, adds six more spellings of the same two
ideas, and asserts nine pieces of legitimate styling are **not** refused — a size
law that refuses `height:24px;overflow:hidden` is a law nobody can ship under.

**Measured.** All eighteen of the critic's stylesheets, run through `emit()`
against the fixture proof, through `deps.userCss` and `deps.themeCss` in turn:
**36 refusals out of 36.** Previously 26 of 36.

The finding is filed at severity 3 by the critic because no product path passes
either stylesheet today. It is fixed now rather than when one does, because L12
is being asked to start passing `themeCss`.

---

## E33 — No base64 pass over inline script; the artifact carries no script the emitter did not write (C16)

**Unsettled by:** §18.4 requires "no network, verified at emit". It does not say
how far the verification chases obfuscation.

**Decision, part one — the thing not done.** The scanner does **not** decode
base64 string literals and rescan them. The §20 critic planted twenty-seven
network references and the scanner caught twenty-six, including
`window["fe"+"tch"]("htt"+"ps://evil.example/x")`. The miss was:

```js
new (window[atob("V2ViU29ja2V0")])(atob("d3NzOi8vZXZpbC5leGFtcGxlL3M="))
```

A base64 pass would catch exactly this and nothing adjacent to it. Hex escapes,
`String.fromCharCode`, `unescape`, ROT13, a two-character XOR and a lookup table
built at runtime are all equally available and all equally undetectable by
pattern, so the rule buys one member of an unbounded set. Against that, the
false-positive cost is real and lands in the wrong place: `atob` is a function
**the artifact's own decoder calls**, base64 literals decode to text that
contains URLs in legitimate cases (a JWT payload names an issuer), and refusing
an emit at severity 1 on a decoded string that was never a destination is the
kind of rule that gets an override flag proposed for it — and §14 does not have
one.

**Decision, part two — what was done instead.** `scanForeignScripts` reports, at
severity 1, any `<script>` in the emitted document that is not one of the five
the emitter writes (`pp-model`, `pp-media`, `pp-manifest` inert; `pp-runtime`,
`pp-boot` executable), with the `type` each is written with, and any duplicate of
one. In a rendered scene the allowed set is empty: a scene renders content, and
content that renders a `<script>` is content that runs.

**Why this is the right shape.** The reason the scanner has to read inline
script at all is that prospect-supplied markup could become executable code in
the artifact. Refusing to carry that code answers the whole class at once, and
answers it the same way whatever the payload is spelled like — the question of
what `atob("V2ViU29ja2V0")` decodes to never has to be asked, because the
element it arrived in is not one the emitter writes. It is also cheap, and it
cannot fire on the artifact's own runtime, because the artifact's own runtime is
the thing it is defined against.

Reported as `NETWORK_REFERENCE` because that is §18.4's code and this is §18.4's
law. §4 fixes the set of codes; inventing a fourteenth to describe one route to
the same failure would help nobody reading the report.

**Reachability, honestly.** No layout in the closed set renders a `raw`
ContentBlock as raw HTML today, so the path is not live — the critic said so and
`test/emit/scanner.test.mjs` confirms the fixture layouts drop it. The test
therefore registers a fixture layout that *does* render raw blocks and drives the
critic's own payload through `emit()`, because a law that holds only because
nobody has exercised the path is not a law.

---

## E34 — `ppReadMediaTable` is a serialized function, not inline boot code

**Unsettled by:** nothing in the spec; a consequence of E31.

**Decision.** The media table reader is a named export of
`src/emit/artifact-runtime.js`, serialized into the boot script by
`artifactRuntimeSource` alongside `ppBase64ToBytes` and `ppRehydrateMedia`, and
counted in both compression variants.

**Why.** The module's opening comment already says why every other function
there is written this way: what ships is exactly what is tested. Writing the
`@src` resolution inline inside `ppBootArtifact` would have put the one piece of
new boot-time logic in the one place ordinary tests cannot reach, and the test
fixture that decodes an artifact's model (`test/fixtures/emit/artifact-dom.mjs`)
calls the real function against a five-line document stub rather than
re-implementing the rule it is checking.

---

## E35 — The refusal names the largest thing in the file, and an unreachable budget spends nothing (P4)

**Unsettled by:** §13 asks for "a report of exactly what was degraded and by how
much", and §22.5 for a refusal. Neither says what a refusal owes the seller when
the thing holding the file open is not an image.

**The finding.** A seller attached four weights of a licensed font — 485KB,
54% of the file — set a 420KB budget, and was told:

```
[SIZE_BUDGET_EXCEEDED] The artifact is 895224 bytes, 475224 over the 420000-byte
budget, after 5 degradation(s). 1 asset(s) could not be degraded:
md_14d5cd1f989c (178 bytes — image/png cannot be re-encoded any smaller …)
```

Five of the prospect's own images had been resampled on the way to a number the
file could never reach, and the obstacle named was the smallest object in the
room. `budget.js` already stated the rule this broke, about a different payload:
*"a seller told 'nothing else can be degraded' while a megabyte of inline SVG
sits in the payload has been told something untrue."*

**Decision, in two parts.**

1. **A budget the ladder cannot reach degrades nothing.** `budgetAssets` now
   answers "can this budget be met at all" before it spends a pixel, and answers
   it two ways: arithmetically, when the document's reserve alone is already over
   the ceiling; and by measurement, by taking every asset to the floor of the
   ladder once and looking. If neither fits, the plan is empty, the proof comes
   back the same object it went in as, and the result carries
   `unreachable: true` with the reason in a sentence. The emit is refused either
   way — degrading the client's photographs on the way to a refusal costs them
   real quality and buys nobody anything.

2. **Every refusal says where the bytes are.** `fixedCostOf` decomposes the
   reserve into named components — embedded fonts (with the families and how
   many faces), the presentation runtime, the model payload, the artifact
   stylesheet, the brand theme, the user stylesheet, the media table, the
   pre-rendered opening beat, and the document scaffolding that is left over —
   and `describeFixedCost` names them largest-first in the finding. It is a
   decomposition, not an estimate: every component is the byte length of a
   string the emitter wrote, less any asset payload written inside it, and
   `test/emit/budget.test.mjs` asserts that the components sum to
   `reserveBytes` exactly and that `reserveBytes + assetBytes` is the file.

**Measured**, on a corpus proof carrying four weights of a real 485KB font on a
face the brand marks embeddable:

```
4 weights: bytes 925024   assetBytes 10478   reserve 914546
census: embedded fonts 485516 [4 faces: Sohne] · the presentation runtime 290155
      · the model payload 50992 · the artifact stylesheet 40277 · the brand theme 782
      · the media table 9 · the pre-rendered opening beat 33945 · scaffolding 12870
census sums to 914546 = reserveBytes, exactly

maxBytes 420000:  REFUSED, 0 degradations
maxBytes 700000:  REFUSED, 0 degradations
maxBytes 900000:  REFUSED, 0 degradations
maxBytes 1200000: emitted 925024, 0 degradations
```

and the refusal now reads:

```
The artifact is 925024 bytes, 505024 over the 420000-byte budget. Nothing was
degraded: the document costs 914546 bytes before a single image, which is already
494546 bytes over the 420000-byte budget, so no amount of image degradation could
meet it. Where the bytes are: embedded fonts 485516 bytes (4 faces: Sohne); the
presentation runtime 290155 bytes; the model payload 50992 bytes; the artifact
stylesheet 40277 bytes; everything else 47606 bytes. Images are 10478 bytes of the
file (1.1%).
```

**Why not put the font on the ladder.** Because a typeface cannot be resampled.
Subsetting is the real answer and it is out of scope; what was in scope was the
emitter telling the truth about which thing is large. `EmitResult.budget.fixedCost`
carries the same census to any caller that would rather draw it than read it.

---

## E36 — One quality dial, bisected on measurements, instead of a six-rung ladder (P7)

**Unsettled by:** §13 — "downscale progressively until under budget" — without a
granularity.

**The finding.** With a 1.6MP photographic hero on a 1,594,939-byte artifact the
old allocator overshot by up to **47.5×**: to shed 7,975 bytes it took the hero
from 1600×1000 to 1200×750 and threw away 378,857. It returned the *identical
file* at every budget across a 25% range, so the setting did nothing over most of
its span, and the step ranking ran backwards in effect — ranks 5 and 6, the least
important assets, took `steps: 0` while rank 0, the hero, took `steps: 1`.

Both halves came from the same design. `SCALE_LADDER` was six rungs
(`1, 0.75, 0.5, 0.35, 0.25, 0.15`), so the smallest downward move available on
any asset was to give up 44% of its bytes; and the greedy loop spent assets in a
queue — least important first, one rung at a time — so the only asset large
enough to matter was the one the queue reached last, and it moved a whole rung
whatever the need was.

**Decision.** The ladder is gone. In its place is one number, `q`, and every
asset's linear scale is `q` raised to a power that grows with its importance
rank: `q` for rank 0, `q³` for the last rank (`scaleForQuality`,
`IMPORTANCE_SPREAD`). `q = 1` is the lossless pass, `q = 0` is the floor, and
everything between downscales *everything*, the least important fastest. §13's
"progressively" is read as one dial over the whole set rather than as a queue in
which the least important asset is destroyed before the most important is
touched.

The dial is found by bisection, and the bracket is only ever moved by a
**measurement**:

1. Measure `q = 1` — the lossless re-encode. It costs no pixels, so it happens
   whatever the budget is.
2. Measure `q = 0` — the floor. This answers E35's "can this be met at all"
   exactly, and gives every asset a second point on its own byte curve.
3. Bisect between them, at most `MEASURED_PROBES` (5) times. Each candidate is
   chosen by solving the *predicted* total — which is free — and then weighed by
   a real decode-resample-encode. The search stops when the unused budget is
   within 2% of what has been given up, or when the bracket is one quantum wide.

Predictions are read off each picture's **own measured curve**
(`logInterpolate`): emitted bytes against linear scale is close to a power law
for a given image, two measurements fix both constants, and the exponent is then
this photograph's rather than an assumption about photographs. That matters
because `predictEmittedBytes`' area model is wrong in a knowable direction — the
corpus hero is 1,181,306 bytes at full size and 61,122 at 15%, where area
predicts 26,500 — and a search that bisects on a systematically wrong model
converges on the wrong answer. It is E26's rule ("predict from a measurement of
*this* image") with the exponent measured too.

Every scale the encoder sees is quantized to `SCALE_QUANTUM` (1/1024), so §5's
byte-identical re-emit survives a search that is otherwise continuous.

**The invariant, restated.** §17.10 asks that "degradation is monotonic in
importance rank". It used to be a property of the loop's visiting order, and the
critic showed it was not true in general — small assets whose re-encode gave
nothing back sat at `steps: 0` below assets that had been resampled. It is now a
property of the formula: `scaleForQuality` is monotone in both arguments, so a
less important asset never keeps more pixels than a more important one, and
`steps` is `scaleSteps(scale)` — hundredths of linear size given up, `0` if and
only if no pixel was. The one clause is assets the codec could not resample at
all: they gave up nothing, so there is nothing to order them by, and their line
says "re-encoded losslessly" rather than claiming a resample they did not do.
Both statements are asserted across five budgets in
`test/emit/budget.test.mjs`.

**Measured**, on the critic's own fixture — a 1.6MP photographic hero
(1,181,306 bytes as a data URI) on a 1,621,254-byte artifact, savings computed
from `len(html)` rather than from anything the emitter reports:

| budget | needed | result | actual saving | overshoot | was |
|---|---|---|---|---|---|
| 1,613,147 | 8,107 | 1,612,617 | 8,637 | **1.1×** | 47.5× |
| 1,588,828 | 32,426 | 1,588,757 | 32,497 | **1.0×** | 11.9× |
| 1,540,191 | 81,063 | 1,538,685 | 82,569 | **1.0×** | 4.8× |
| 1,459,128 | 162,126 | 1,454,257 | 166,997 | **1.0×** | 2.4× |
| 1,297,003 | 324,251 | 1,293,221 | 328,033 | **1.0×** | 1.2× |

The hero now goes 1600×1000 → 1591×994 to shed 8,107 bytes, where it used to go
to 1200×750; every budget produces a different file; and the reported saving is
still the real saving, to within 1–35 bytes at every one.

**Cost.** Seven measured re-encodes per asset at worst, against two before. On
the fixture above one `emit()` takes about 10 seconds where it took 6. That is
the price of not throwing away a third of the client's hero to save half a
percent, and it is paid only when a budget actually binds.

---

## E37 — The label's paint is measured, not its `color` declaration (P8)

**Unsettled by:** §18.1 — the label "cannot be styled to invisibility (contrast
and size floors enforced at emit)" — which names two floors and no properties.

**The finding.** Two of thirty-nine CSS attacks were emitted and then verified to
work in Chromium:

```css
.pp-provenance{-webkit-text-fill-color:transparent}   /* colour unchanged and compliant; text gone */
.pp-provenance{filter:blur(20px)}                     /* 12px type under a 20px blur */
```

E32 had already moved this check once — from "is this declaration on our list"
to "is there room for the text" — and the same question applied again. Adding two
properties to a list would have been the same mistake in a third decade.

**Decision.** Two measurements, each closing a class rather than a spelling.

1. **The glyph paint, not `color`.** `glyphPaint()` computes what actually fills
   a glyph: `-webkit-text-fill-color` where it is set, `color` otherwise. The
   contrast floor is then measured on that. `color:transparent`,
   `-webkit-text-fill-color:transparent`, and a fill at 2% alpha are one finding
   rather than three rules, and the properties are marked inherited because they
   are — a rule on `<body>` reaches the label's text exactly as `color` does. A
   zero-alpha fill falls through to `-webkit-text-stroke-color` when there is a
   stroke wide enough to draw, because outlined type is a design and not a hiding
   place; a stroke of zero width paints nothing and rescues nothing.

2. **A filter is either a colour transfer or a blur.** `parseFilter()` splits
   `filter` into the two different things filters do. The colour transfers —
   `opacity`, `brightness`, `contrast`, `invert`, `grayscale`, `saturate`,
   `sepia` — are evaluated exactly, on the two colours §18.1 already measures, so
   `filter:brightness(0)`, `filter:opacity(0)`, `grayscale(1) brightness(12)`
   and `contrast(0)` are all the *same* contrast finding. Blur is the one
   operation on text that is not a function of colour, so it gets the one
   measurement colour cannot make: the radius against the type it is applied to.
   `LABEL_MAX_BLUR_EM` is 0.04 — a third of a pixel on 12px type, a softness a
   designer might want and a reader will not notice — and 20px is fifty times a
   12px face's stem width. It is a ratio for the same reason the size floor is,
   so that `blur(1.6em)` is already answered.

**What this deliberately does not do.** The colour transfer is applied from the
label's own `filter`, and to the backdrop as well only when the label paints an
opaque background of its own — because a filter on an *ancestor* filters the
illustrative content with the label, which is a broken deck rather than a
provenance leak, and the critic checked each of those in a browser and agreed.
The one ancestor case still named is a transfer that paints at zero alpha, which
erases without touching anything else's legibility. Blur does compose down the
chain, in quadrature, because a blurred ancestor really does blur the label.

**Measured.** Both holes now refuse at emit; the thirty-seven the critic's sweep
already caught still refuse; and five things a real stylesheet does —
`blur(0.3px)`, `drop-shadow(...)`, `saturate(1.2)`, a fill colour that is simply
a colour, `-webkit-text-fill-color:currentColor` — still pass, along with
`invert(1)` on a label that paints its own background, which inverts the
background with the text and is a light label rather than a hidden one. A rule
that listed `invert` would have refused that; a measurement does not.

---

## E38 — `deps.fonts` cannot embed a face the model does not mark embeddable (P9)

**Unsettled by:** §7 puts the assertion on `TypeFace.embeddable`; L10-D2 records
that `TypeFace` has nowhere to carry the bytes, which is why `deps.fonts` exists
at all.

**The finding.** Passing a real font in `deps.fonts` embedded it whatever the
brand said, so `embeddable` was one door into §7's law and `deps.fonts` was a
second. The artifact then rendered in the embedded face while preflight had
measured all 125 `TEXT_OVERFLOW` findings against Arial.

**Decision.** `partitionFonts()` embeds a `deps.fonts` entry only when the
proof's own brand carries a face of that family marked `embeddable: true`.
Family matching normalizes quoting, case and surrounding space, so `"söhne
breit"` and `Söhne Breit` are the same family; the flag itself is never inferred
from anything. A refused entry is reported as `FONT_UNAVAILABLE` at severity 2 —
its declared severity — naming the family and the route: attach the licensed
file to the face through L5's `attachUserFont`, which is the only function in the
repository that sets the flag.

**Why severity 2 and not a refusal.** Because nothing about the artifact is then
a lie: it renders the fallback stack, which is exactly what preflight measured
against, and L11 already raises `FONT_UNAVAILABLE` for the substitution itself.
What the seller is owed is the reason their attached font did not appear, and a
severity-2 finding is where that belongs. `EmitResult.fonts` carries
`{embedded, refused}` for a caller that wants to say so in its own words.

`licenseAsserted: true` is still required and still not sufficient: a font
nobody asserted a licence for is neither embedded nor mentioned, exactly as
before.

---

## E39 — The absolute-URL scanner's scheme is bounded, because an embedded font made it quadratic (found under P4)

**Unsettled by:** nothing in the spec. Found while measuring P4.

**What happened.** Reproducing P4's scenario — four weights of a licensed font,
485KB of base64 — `emit()` took **166 seconds** for one refusal. Nothing about
the budgeter was slow; `scanCss` was:

```
scanCss  10,000 chars    198 ms
scanCss  20,000 chars    803 ms
scanCss  40,000 chars  3,084 ms
scanCss  80,000 chars 12,432 ms
```

`ABSOLUTE_URL_RE` was `/[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/…/g`. On a long run of
base64 the engine starts the greedy scheme run at *every* character, consumes
the rest of the run looking for a `://` that is not there, fails, and advances
by one. A document is exactly where long alphanumeric strings live, and the more
of the file the seller inlines, the worse it gets.

**Decision.** Bound the scheme at 32 characters:
`/[a-zA-Z][a-zA-Z0-9+.\-]{0,31}:\/\/…/g`. Same eight lines: 5ms, 8ms, 16ms,
30ms. `emit()` on the same font proof went from 166 seconds to 0.5.

**Why this costs no detection.** The match may start anywhere, so a scheme
longer than the bound is still found — the last 32 characters of it are a match,
and `test/emit/scanner.test.mjs` asserts that a 200-character scheme is still
reported. What the bound removes is the restart, not the finding. The longest
scheme IANA has registered is 20 characters, a base64 body cannot contain the
`:` that would make one, and no engine resolves a 33-character scheme anyway.

Worth naming as a decision rather than a tidy-up because of what it was: the
no-telemetry law is verified by this scanner on every emit, and a scanner whose
cost is quadratic in the size of an inlined asset is a scanner a large enough
proof turns into a hang. Three tests now hold it: the long-run detection cases,
the long-scheme case, and a bound on the scan time itself.

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
  <script id="pp-media"    type="application/octet-stream">{one data: URI per line}</script>
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
   paint. They are inert: a `<script>` with a non-executable type is data.
4. The runtime, then the boot script, which reassembles the model and makes the
   keyboard work.

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
not read text nodes, `<title>`, or `<textarea>` content.

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

**Decision.** Severity 1. The emit is refused.

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

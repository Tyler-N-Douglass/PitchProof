# CRITIQUE-1

Adversarial critic, pass 1, against `PITCHPROOF-BUILD-SPEC-v1.0.md` §20.

**Verdict: 6 axes pass, 5 fail. 7 severity-1 findings. The build does not meet §1.2.**

The suite is green, the gates are green, and the product does not work. A proof
assembled through the studio from the fixture corpus emits a brand with **zero
colour roles, zero faces and zero logos**, and every page captured from a URL
carries a blocking `ASSET_MISSING` — because ingest never fetches a page's
stylesheet or its images and nothing in the test suite ever asked it to. The
colour engine underneath is exact and well-tested; it is fed nothing, and when
it is fed something it reads brand colours out of CSS **variable names** rather
than their values.

---

## §20 axis scorecard

| # | Axis | Verdict |
|---|---|---|
| 1 | Contract fidelity | **PASS** |
| 2 | Determinism | **PASS** |
| 3 | Colour correctness | **FAIL** — F2 |
| 4 | Offline integrity | **PASS** |
| 5 | Overflow detection efficacy | **FAIL** — F6, F7 |
| 6 | Branch integrity | **PASS** |
| 7 | Provenance enforcement | **PASS** |
| 8 | Presentation robustness | **PASS** |
| 9 | Degradation honesty | **FAIL** — F12, F13, F17 |
| 10 | Studio usability under pressure | **FAIL** — F1, F3, F5, F14, F15 |
| 11 | Non-goal violations | **PASS** |

---

## §20 preamble: what I ran before writing

> "The critic must actually build and present a proof end to end from the
> fixture corpus before writing its report."

Everything below is under `.tmp/critic/`. All of it uses the corpus `http`
stand-in and `corpusClock()`; no driver reaches the network.

| Script | What it did |
|---|---|
| `pipeline.mjs` | The full chain: `ingestUrl` × 4 corpus pages, sitemap discovery, `.docx` + `.pdf` import, sub-resource fetch, `extractPalette` → `buildBrandSystem` → `compileTheme`, `buildSpecimen` × 6 with siblings, 8 seed recipes → 34 renditions, 6 spine scenes across 6 layouts, 4 branches (one nested), `branchCoverage`, `buildJumpIndex`, `runPreflight`, `emit` |
| `build-presentable.mjs` | Trimmed that proof until the product would emit it, recording every trim; produced `northwind.pitchproof.html` (532,704 bytes) |
| `present.mjs`, `present2.mjs` | The artifact in headless Chromium from `file://`, every non-`file://` request aborted: full spine walk against an independent Node simulation of `navigate()`, back-navigation from every beat, jump index typed character by character, nested jump + unwind, automatic branch exit, blank screen, branch map, contents, help, presenter window, `Home`/`End`/`↑`/`↓` |
| `studio-full.mjs`, `studio-complete.mjs` | `dist/pitchproof-studio.html` from `file://` with the corpus origin fulfilled from the fixture files and everything else aborted: the whole §1.2 flow, project → brand → specimens → recipes → scenes → branches → rehearse → emit |
| `09/10/11/12-*.mjs` | 20 planted network references in the finished HTML, 10 protocol-relative variants, 8 planted through the model |
| `18/19-*.mjs` | 11 hand-built branch orphans |
| `20-provenance.mjs` | 12 routes to unlabelled illustrative content, including a hand-forged promotion record |
| `22-degrade.mjs` | Forced size budgeting with 15 × 600×400 noise PNGs at four budget fractions |
| `13/14/15/16-*.mjs` | Overflow isolation per layout, per specimen, per breakpoint |
| `24-emit-vs-preflight.mjs` | Whether `emit()` refuses what preflight blocks |
| `27-emit-once.mjs` | Byte-identical emit across four separate processes |

**Gate results, re-run by me** (`npm run verify`, `.tmp/critic/verify.log`):

```
# tests 1625  # pass 1625  # fail 0
determinism: clean — no unseeded randomness or wall-clock reads in src/
build: deterministic — 3 output(s) byte-identical across two builds
verify-offline: clean   (0 requests, FCP 72ms and 76ms against a 1500ms budget)
EXIT=0
```

All four gates confirmed. They do not detect any of the seven severity-1
findings below.

---

## Severity 1

### F1 · The studio extracts an empty brand from any normal website

`src/ui/services.js:665-693` (`brandParts`), `src/ingest/fetch.js:365`
(`ingestUrl`).

`ingestUrl` fetches the document and nothing else. `brandParts` then hands
`extractPalette` the **HTML text** as its `css` source
(`src/ui/services.js:667`: `const css = captures.map((c) => c.html || '')`),
and `images: []` (`:688`). The corpus pages declare every colour, every
`@font-face` and the logo in `/assets/site.css` and `/assets/logo.svg` — which
is what every real site does — so:

- `extractPalette` throws `no colours could be collected from any source`,
  is caught at `src/ui/services.js:679`, and returns `{colors: [], confidence: 0}`;
- `detectFaces(doc, css)` sees no `@font-face` and no `font-family`;
- `extractLogos(doc, [])` cannot resolve `<img src="/assets/logo.svg">`.

Driven through the built studio (`.tmp/critic/studio-flow.mjs`), typing the
corpus URL and pressing **Extract**:

```
requests served from the corpus: ["/"]
{"colors":[],"noColors":true,"noFaces":true,"noLogo":true}
toast: "Brand extracted. Every group below its confidence floor is held for your review…"
panel: "No colour roles yet."  "No faces detected yet."  "No logo captured."
confidence: Colors 0%  Faces 0%  Logos 0%  Shape 0%  Imagery 0%
```

The same corpus, with sub-resources fetched by my driver instead
(`.tmp/critic/pipeline.mjs`), yields 14 colour roles, 2 faces and 4 logos. The
lane code works. The studio never feeds it.

§1.2 is *"paste a prospect URL, get an extracted brand system and a specimen
library"*. It reports success and produces neither. **Severity 1.**

### F2 · Brand colours are fabricated from CSS custom-property *names*

`src/brand/color-css.js:276`.

```js
const re = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|hwb|oklch|oklab)\([^()]*(?:\([^()]*\)[^()]*)*\)|[a-zA-Z]{3,20}/g;
```

`-` is not in that final character class, so `var(--nw-navy)` yields the token
`navy`, and `parseCssColor('navy')` returns `#000080`. Meanwhile
`collectFromCss` (`src/brand/cluster.js:290-299`) accepts only `FILL_PROPS`,
`LINE_PROPS` and `TEXT_PROPS` and `continue`s on everything else — so
`--nw-navy: #0F2A47`, the declaration holding the *real* value, is discarded.

Reproduced minimally (`.tmp/critic/03-collect.mjs`, `04-samples.mjs`):

```
var(--nw-navy)            -> #000080
var(--brand-orange)       -> #ffa500
var(--tomato-sauce)       -> #ff6347
:root{--nw-navy:#0F2A47} a{color:var(--nw-navy)}  -> #000080
custom-property declaration alone                 -> (none)
```

Consequence on the corpus, whose declared brand is
`navy #0F2A47 / orange #E8622C / steel #5A6B7C / ink #14202B`:

```
primary  #000080 extracted     accent  #ffa500 extracted
onPrimary #fff7f2             onAccent #000080
```

**Not one extracted role is a colour the site renders.** The emitted artifact
wears HTML `navy` and HTML `orange`; see the screenshot
`.tmp/critic/scene-fanout.png`, where the headline is `#000080` and the
rendition counter is orange. This is §22.1 in its most literal form and §18's
honesty law in substance: the tool tells the client "this is your brand" about
colours the client does not use.

The test that should have caught it dodges it. `test/brand/color-cluster.test.mjs:168`:

```js
assert.equal(collectFromCss('.x { color: var(--y) } .z { color: currentColor }').length, 0);
```

`--y` contains no colour keyword. Any variable name containing one — `--nw-navy`,
`--brand-orange`, `--text-gold`, `--accent-teal` — fails. **Severity 1.**

### F3 · Every URL-captured specimen carries a blocking `ASSET_MISSING`

Same root cause as F1. `ingestUrl` returns `assets: []`, so `buildSpecimen`
produces media blocks whose `ref` is a path with no `MediaRef` behind it.

Node repro (`.tmp/critic/23-studio-specimen.mjs`):

```
capture.assets: 0
specimen media: 0
media blocks: [ '/assets/hero-plant.png' ]
preflight sev1: ASSET_MISSING — Block 4 of specimen "Northwind Industrial …"
                shows media "/assets/hero-plant.png", and no media reference
                with that id exists in the proof.
```

In the studio, after capturing three corpus pages and adding three scenes and
three branches, the rehearsal sweep reported **6 blocking findings, three of
them `ASSET_MISSING`**, and the emit was refused. The only offered remedy is
the auto-fix *"Remove the block referencing missing media"* — i.e. delete the
prospect's own hero image from the proof. **Severity 1.**

### F4 · `.docx` / `.pdf` import loses every embedded image

`src/specimen/specimen.js:159-164`:

```js
if (Array.isArray(capture.blocks) && capture.blocks.length > 0) {
  blocks = capture.blocks.map((b) => ({ ...b }));   // refs copied verbatim
  locator = 'importer';
```

The HTML path resolves refs through `blocksWithTrace(body, { media })`
(`:185`). The importer path does not. So the importer's ZIP/PDF part name
survives while `captureMedia` mints a content-hash id:

```
sp_d2e183c37b22 (hx-400-proposal.docx)
  media refs:   md_898ba86dce85 (713B 240x180)
  media blocks: {"type":"media","ref":"word/media/image1.png",…}
sp_eef5f53c407c (hx-400-design-note.pdf)
  media refs:   md_7fb553b593c1
  media blocks: {"type":"media","ref":"page001-Im1.png",…}
```

Three severity-1 `ASSET_MISSING` findings from two documents. The image is in
the proof, is inlined, and is unreachable. **Any `.docx` or PDF containing an
image makes a proof un-emittable.** §6.5 is a required ingest path. **Severity 1.**

### F5 · Rehearsal passes the provenance label; the emitter then refuses it

`src/runtime/runtime.css:239-240`:

```css
background: var(--pp-warning);
color: var(--pp-on-primary);
```

`src/validate/contrast.js:54`:

```js
export const PROVENANCE_PAIR = { fg: 'onSurfaceAlt', bg: 'surfaceAlt' };
```

Two lanes disagree about which roles the §18.1 label wears. `ROLE_PAIR` pairs
`warning` with `surface` and `onPrimary` with `primary`; **no solver
post-condition covers `onPrimary` against `warning`**, and `CONTRACTS-DISPUTES.md`'s
own "recorded non-disputes" notes the `warning`/`surface` pairing without
noticing that the label uses neither.

On the corpus brand (`.tmp/critic/07-contrast.mjs`):

```
LABEL AS RENDERED  (runtime.css:239)      #fff7f2 on #797900 = 4.3621
LABEL AS CHECKED   (contrast.js:54)       #000080 on #fff7f2 = 15.1242
checkContrast findings: 2, neither about the label
runPreflight findings: 75 — codes ASSET_MISSING, TEXT_OVERFLOW, CONTRAST_FAIL,
                       FONT_UNAVAILABLE.  Zero PROVENANCE_UNLABELED.
emit(): REFUSED — 50 severity-1 PROVENANCE_UNLABELED
        "does not survive the emitted stylesheet: computed contrast is 4.36:1"
```

A seller runs rehearsal, sees a clean provenance result, presses Emit, and gets
50 blocking findings with no override and no auto-fix. §14 makes rehearsal "a
first-class mode, not a lint pass"; a rehearsal that clears what the emitter
refuses is worse than no rehearsal. **Severity 1.**

I cleared it by hand-deriving `warning` to `#777600` — a manual override no
part of the product offers, because the finding never appears in a panel.

### F6 · The specimen's own source URL blocks the emit in four of eight layouts

`src/scene/parts.js:105` renders the panel meta line with `data-pp-clamp="1"`;
`src/scene/scenes.css:497-502` gives that `white-space: nowrap; overflow: hidden;
text-overflow: ellipsis` — a deliberate, designed truncation with a visible
ellipsis. `src/validate/overflow.js:388-398` then measures the box, sees the
text is wider than the container, and raises **severity 1** `TEXT_OVERFLOW`.

Isolated (`.tmp/critic/16-why-overflow.mjs`) by shrinking every text block in
the corpus article to two characters:

```
splitBeforeAfter  text only  blocks=16  SEV1 1 {"panelMeta":1}
sideNote          text only  blocks=16  SEV1 1 {"panelMeta":1}
stack             text only  blocks=16  SEV1 1 {"panelMeta":1}

sm  panelMeta is 88.7px wider than its 320px container at sm (27.7% over):
    "www.northwind-industrial.example/insights/fouli…"
    unbreakable: ["www.nor…"]
```

Threshold, measured: a display URL of **54 characters** at `sm` (10px mono,
320px container) crosses the 2% severity-1 ratio. The corpus URL is 57.

Measured across all eight layouts against the real corpus specimens, with no
seller-authored text at all (`.tmp/critic/15-layout-corpus.mjs`, severity-1
count summed over `sm`/`md`/`lg`):

| specimen | split | fanOut | stack | fullBleed | sideNote | systemMap | quoteCard | contents |
|---|---|---|---|---|---|---|---|---|
| home | **51** | 3 | 2 | 0 | **14** | 0 | 0 | 5 |
| product | **30** | 16 | 8 | 0 | **38** | 0 | 3 | 5 |
| article (en) | **60** | 3 | 1 | 0 | **49** | 0 | 0 | 5 |
| article (de) | 1 | 0 | 1 | 0 | 1 | 0 | 3 | 3 |

`splitBeforeAfter` — the layout the entire before/after thesis rests on —
produces 30 to 60 blocking findings per specimen. Severity 1 blocks emit, there
is no override (§14), there is no auto-fix for `TEXT_OVERFLOW`, and the
offending text is either the prospect's own title and URL (which §18.3 says are
presented unmodified) or chrome the layouts and recipes generate themselves.

To get an artifact I could present at all I had to shorten every specimen's
`sourceUrl` and `title` and cap every paragraph — the trim log is in
`.tmp/critic/build-presentable.mjs` output. Without shortening the URLs,
`splitBeforeAfter`, `sideNote` and `stack` were **"DROPPED — overflows at every
text length down to 10 chars"**. **Severity 1.**

The grading is the defect, not the measurement: the detector knows the box is
`nowrap` (it says so in the message) and knows `maxLines === 1`, and still
grades a designed ellipsis as a blocking defect. Note the inconsistency —
losing **two lines of the client's own copy** to a multi-line clamp is graded
severity **2** ("body is clamped to 6 lines at md but needs 8, so 2 lines of
copy is truncated and never reaches the viewer"), while losing the tail of a
URL to a one-line clamp is graded severity **1**.

`SceneMeasurement.boxes` (API.md → L8) has no `textOverflow` field, so the
detector cannot in principle tell "clipped, data lost" from "ellipsised by
design". That is the contract gap underneath the finding.

### F7 · The §17.4 planted corpus never exercises the class that breaks the product

`test/fixtures/overflow/corpus.mjs`. Re-measured
(`node --test test/validate/overflow-corpus.test.mjs`):

```
severity-1 recall    1.0000   (48 found of 48)
severity-1 precision 1.0000   (48 of 48 calls)
```

Then I inspected what those 93 cases actually contain:

```
whiteSpace: { nowrap: 54, normal: 39 }
maxLines:   { '2': 2, '3': 1, '4': 2, none: 88 }
roles:      headline 38, body 32, provenance 9, paragraph 7, eyebrow 4, meta 3
```

**Zero cases with `maxLines: 1`.** Every severity-1 overflow the product
produced on its own corpus is a `nowrap` + `clamp-1` case. The perfect
recall/precision figure is real and is measured over a case distribution that
excludes the failure mode. §17.4 says planted-defect corpora "are the only
honest way to know a detector works" — this one does not cover the shape the
layouts actually emit, and no case carries the `meta`/`panelMeta` role at a
one-line clamp.

Note also that the oracle in `test/validate/overflow-corpus.test.mjs`, though
independently written, encodes the *same policy choice* as the detector
("nowrap width overflow is severity 1"). An independent oracle proves the
arithmetic, not the policy. **Severity 1** (the measurement §17.4 requires does
not cover the classes the product hits).

---

## Severity 2

### F8 · `emit()` writes artifacts carrying severity-1 findings

`API.md` Part 3 → L10: *"A severity-1 finding refuses the emit. There is no
override flag anywhere in the codebase."* §14: *"Severity 1 findings block emit.
There is no override flag."*

`.tmp/critic/24-emit-vs-preflight.mjs`:

```
as built:          preflight sev1 = [ TEXT_OVERFLOW ]                emit ok = true  532704B
huge headline:     preflight sev1 = [ TEXT_OVERFLOW ×4 ]             emit ok = true  533100B
broken onSurface:  preflight sev1 = [ TEXT_OVERFLOW, CONTRAST_FAIL ] emit ok = true  532712B
```

`emit()` enforces only the emitter-owned laws (network, provenance, asset,
size, contract shape). `TEXT_OVERFLOW` and `CONTRAST_FAIL` — including a body
text pair below 4.5:1, which §14 pins at severity 1 — pass straight through.
The law survives in the shipped product only because `src/ui/gate.js` runs
preflight separately before enabling the button; §9's own reasoning ("enforce
this in the emitter, not just in the UI") applies here too.

The artifact I presented in §20.8 was emitted this way, carrying one severity-1
`TEXT_OVERFLOW`. **Severity 2** on the grounds that the studio does enforce it —
but the API.md sentence is false as written and should be corrected or the
emitter should run the overflow and contrast rules.

### F9 · `metricDelta` claims an unknown face substitutes perfectly

`src/core/text-metrics.js` → `resolveFace`. `.tmp/critic/05-face.mjs`:

```
Sohne                   -> Arial           known=false conf=0.600 delta={"capHeight":1,"xHeight":1,"avgAdvance":1}
Bodoni Ultra Condensed  -> Times New Roman  known=false conf=0.600 delta={"capHeight":1,"xHeight":1,"avgAdvance":1}
Comic Sans MS           -> Arial           known=false conf=0.600 delta={"capHeight":1,"xHeight":1,"avgAdvance":1}
Inter                   -> Arial           known=true  conf=0.826 delta={"capHeight":1.015363,…}
```

For any family the metric tables do not know — which is exactly the custom
webfont on a prospect's site, the §22.2 case the corpus was built around — the
product reports the substitution as metrically *identical*. §4 permits
`metricDelta: null` and `neutralBrand()` (`src/scene/brand-access.js:91-93`)
uses `null` correctly; `resolveFace` fabricates `1`. The studio's brand panel
surfaces it as "the delta is what predicts the overflow", so the seller is told
a condensed display face and Times New Roman are the same width.

Overflow detection itself is unaffected (it measures the resolved face, which is
correct). The dishonesty is in what is reported. **Severity 2.**

### F10 · A hero photograph becomes the client's `primary` logo

`.tmp/critic/06-logo.mjs`, on the corpus home page:

```
mark      svg     48x48   source=link-icon-svg
primary   raster  320x180 source=og-image        <- /assets/hero-plant.png
wordmark  svg     240x48  source=header-raster   <- /assets/logo.svg, the actual logo
```

§7's order is "inline SVG, then `<link rel=icon>` SVG, then og:image, then the
largest raster in the header region". The extractor found the header logo and
filed it as `wordmark`; `primary` went to the og:image. `logoFor(brand)`
(`src/scene/brand-access.js:73`) defaults to `'primary'`, so every layout that
asks for the brand's logo renders a picture of a plant. The page also carries
JSON-LD `Organization.logo` pointing at `logo.svg`, which is not consulted.

(The auto-generated inverse of that image is *in* spec — the fixture hero is a
genuine single-hue navy graphic, `monochromeOf` reports "one hue, spread 1.7deg
over 99.8% of the mark". Not a finding.) **Severity 2.**

### F11 · Nothing in the product can pop one return frame

`src/runtime/keymap.js:41` binds `r`/`R` to `returnToSpine`, which unwinds the
whole stack. Grepping for a dispatcher of `{type: 'return'}` across `src/`
finds exactly one hit: `src/branch/walk.js:34`, the property test's random
walker.

The reducer is correct — verified in Node (`.tmp/critic/17-return-stack.mjs`):

```
jump bn_approvals             bn_approvals/sc_d353…/0  stack=[spine:0:0@anchor]
jump bn_legal (nested)        bn_legal/sc_5a09…/0      stack=[spine:0:0 | bn_approvals:1:0]
{type:return} once            bn_approvals/sc_bca6…/0  stack=[spine:0:0]
walked off the end of legal   bn_approvals/sc_bca6…/1  stack=[spine:0:0]
```

and in the browser the automatic exit unwinds one level at a time. But the only
key a presenter has collapses to the spine. From a nested branch there is no way
back into the parent branch except re-jumping to it. §11 says the return stack
exists "so nested jumps unwind correctly"; it does, and the keyboard cannot
reach it. **Severity 2.**

### F12 · Assets are inlined once per specimen

In my corpus proof, `.tmp/critic/proof-clean.json`:

```
identical dataUri under 3 ids: md_9c388d2b6bf4,md_a6a2d59e0ecc,md_db6af62d8fda   450 bytes each
identical dataUri under 3 ids: md_4e16750af08d,md_56f4e67a54b6,md_86970c9899ed  3586 bytes each
identical dataUri under 3 ids: md_ac815cef1184,md_fa28e76d8b7c,md_65ad553f0f68  1094 bytes each
identical dataUri under 3 ids: md_4c76b97f80ff,md_d1a00187891f,md_7ca8c9122508   974 bytes each
identical dataUri under 3 ids: md_7a357e0b8e91,md_26db61000303,md_4409eb088d86   610 bytes each
duplicate groups 5, wasted bytes 13428 of 20142
```

**67% of the media payload is byte-identical duplicates.** `captureMedia`
dedupes by SHA-256 within one call (`src/specimen/media.js:78-83`), but each
specimen is a separate call, so a shared logo or hero is stored once per page
captured. The emitter never notices. §13 budgets aggressively against
`maxBytes` while carrying n copies of the same bytes. **Severity 2.**

### F13 · The degradation report double-counts and mispredicts

`.tmp/critic/22-degrade.mjs`, 15 assets replaced with 600×400 seeded-noise PNGs
(14,941,992-byte artifact), budget at 60%:

```
budget 8,965,195 (60% of 14,941,992):
  emitted 6,898,125 — within budget
  32 degradation lines
  distinct assetIds in the report: 15 of 32 lines
  |actual-predicted|/predicted: min 9.3%  median 1200.0%  max 1532.1%
  lines where predicted is within 10% of actual: 13/32
  quality changed on any line: false
    md_7a357e0b8e91 rank=0 200x120@0.85 -> 30x18@0.85 pred=14 actual=182
    md_7a357e0b8e91 rank=1 200x120@0.85 -> 30x18@0.85 pred=14 actual=182
    md_7a357e0b8e91 rank=2 200x120@0.85 -> 30x18@0.85 pred=14 actual=182
    md_65ad553f0f68 rank=31 600x400@0.85 -> 450x300@0.85 pred=540440 actual=489758
```

Three defects in one report:

1. **32 lines, 15 distinct asset ids.** The same asset is reported degraded up
   to four times (once per reference), so summing the report over-counts. §17.10
   asserts "the reported degradation matches actual bytes saved"; it cannot,
   because it counts one asset's saving several times.
2. **Median prediction error 1200%.** `predictedBytes: 14` against
   `actualBytes: 182`. The large lines are within ~10%; the small ones are an
   order of magnitude out. Only 13 of 32 lines are within 10%.
3. **`quality` never changes on any line.** Every degradation is a resample.
   `QUALITY_STEPS` and the `from.quality`/`to.quality` fields are inert.

Monotonicity in importance rank does hold (ranks degraded in ascending order at
every budget). **Severity 2.**

### F14 · The studio cannot run a seed recipe

`grep -rn 'renderRecipe\|renderAll\|RECIPE_TEMPLATES' src/ui/` returns nothing
but the studio's own `renderRecipesPanel`. `src/ui/services.js` calls
`recipeLane.SEED_RECIPES`, `alignBlocks`, `parsePasted`, `buildRendition`,
`promoteProvenance`, `channelBudget`, `enforceBudget`, `runAdapter` — and never
`renderRecipe` or `renderAll`.

In the studio, the Recipes panel shows "Load the eight seed recipes", after
which the Recipe select is still empty ("Load the recipe library first") and the
only routes to a rendition are **Paste a rendition** and **Use the adapter**.

The eight templates in `src/recipe/templates/` work — my driver got 34
renditions out of them in one call:

```
locale-fanout      -> 9  [en-US, de-DE, fr-FR, es-MX, pt-BR, ja-JP, zh-CN, ru-RU, ar-SA]
channel-variants   -> 4  [Email, Paid social, In-product message, SMS]
system-assembly    -> 3  governed-iteration -> 5  approval-chain -> 5
volume-view        -> 3  dam-round-trip     -> 3  brief-to-asset -> 2
```

§9 calls the seed library "the reframe payload — build all of them". It was
built and is unreachable from the shipped studio.

This is not an oversight nobody noticed — it is declared. `API.md:709`, Part 5:

| L7 | `recipe/index.js` | `renderRecipe`, `renderAll`, `RECIPE_TEMPLATES` | **How a caller actually gets renditions out of a recipe.** L12 depends on it |

and `docs/INTEGRATION-NOTES.md` says the same. `api-conformance.test.mjs`
checks that L7 *publishes* those exports — which it does — and nothing checks
that L12 consumes them, so the dependency API.md records is stated, tested from
one side, and unwired on the other. **Severity 2.**

### F15 · The §7 review gate can be cleared against an empty brand

`.tmp/critic/studio-flow.mjs`, immediately after the failed extraction of F1:

```
before: "7 things block the emit"
click "I have checked all of these"
after:  "2 things block the emit"
colours still empty after "checked": true
```

Five groups at 0% confidence, containing nothing, marked reviewed by one
button, and five of the seven emit blockers cleared. §7 says the studio
"surfaces low-confidence fields for review before they can be used in an emit";
reviewing an empty field set is not a review. The gate should refuse to clear a
group that has no content. **Severity 2.**

### F16 · A beat whose reveals point at nothing is not a finding

`.tmp/critic/18-orphans.mjs`, case *"beat that reveals an element id nothing
renders"*: `p.spine[0].beats[0].reveals = ['el_deadbeef00']` produces no new
finding at any severity. `BEAT_EMPTY` covers a beat with no reveals; a beat
whose reveals all name absent elements is functionally identical — the
presenter presses `→` and nothing happens — and is invisible to the sweep.
**Severity 2.**

### F17 · A third of every artifact is source comments

```
runtime bundle 431,608 bytes; comment bytes ~158,804 = 36.8%
artifact 532,084 bytes; runtime share 81.1%
media in the proof: 20,142 bytes of data URI (3.8% of the file)
```

The bundle is not minified and ships its JSDoc and prose. §13 has the budgeter
progressively downscale the *client's* images — which are 3.8% of the file —
while 159KB of comments are untouchable. Cold boot is not affected (72ms
measured, against a 1500ms budget), so this is budget-honesty rather than
correctness: the degradation report tells a seller their hero image was
resampled to 15% while the largest single removable payload is never
considered. **Severity 2.**

---

## Severity 3

- **F18** · `scripts/build.mjs:237` reports `contents.length` — UTF-16 code
  units — as "bytes". The build log says `wrote dist/pitchproof-studio.html
  2,773,619 bytes`; the file on disk is 2,777,782. (`emit()` itself uses
  `utf8Length` correctly, verified: reported 532,704 = on-disk 532,704.)
- **F19** · `MediaRef.bytes` is the decoded source size, not the inlined cost:
  `md_4e16750af08d` declares `2673` and its `dataUri` is `3586`, a uniform 34%
  understatement. `budgetAssets` uses `utf8Length` and is unaffected; anything
  reading `MediaRef.bytes` to show a seller a size is wrong by a third.
- **F20** · `branchAnchors: ['bn_ghost']`, naming a branch that does not exist,
  produces no finding at any severity (`.tmp/critic/18-orphans.mjs`).
- **F21** · `BRANCH_UNREACHABLE` for the exact §14 condition — no anchor **and**
  no jump entry — is raised at severity **2**, with the message "no key the
  presenter can press reaches it". Its scenes still ship in the artifact.
  Non-blocking is defensible; shipping unreachable scenes silently is not.
- **F22** · `src/ui/panels/branches.js:219` — with zero branches the jump-index
  hint reads "The branch lane builds this index; it is **not wired into this
  build**", which is false. The lane is wired; there are no branches yet.
- **F23** · `promotionSignature` (`src/recipe/provenance.js:115`) is
  `shortHash({v,by,at,of,from}, 16)` — unkeyed — and `formatPromotionRecord` is
  exported from `src/recipe/index.js`. A hand-forged record with a correct
  signature promotes any rendition to `verified-by-user` and emits cleanly
  (`.tmp/critic/20-provenance.mjs`). In a fully local, user-owned model no
  signature scheme can do better; the finding is that `signatureValid` reads as
  an authenticity check when it is tamper-evidence against corruption. Document
  the limit.
- **F24** · **The end-to-end fixture corpus is not exercised by anything.**
  `grep -rn 'corpusHttp\|pageHtml\|CORPUS_PAGES\|documentBytes\|assetBytes\|CORPUS_BRAND'`
  across `test/` and `scripts/` returns no hits outside
  `test/fixtures/corpus/index.mjs` itself; the only import anywhere is
  `corpusClock` in `test/integration/artifact.test.mjs`. Both
  `verify-offline.mjs` and `test/integration/artifact.test.mjs` drive
  `test/fixtures/make-proof.mjs`, whose proof has **zero specimens and zero
  renditions** and whose scenes carry `specimenId: null`. No layout in CI ever
  renders real content, no provenance label is ever painted in the offline
  walk, and no measurement is ever taken of a real specimen. That is why F5 and
  F6 survived 1625 green tests. I would raise this to severity 2.

---

## Axis by axis

### 1. Contract fidelity — **PASS**

The `FROZEN REGION` in `src/core/contracts.d.ts` is byte-identical to the §4
block of the spec and to `test/fixtures/frozen-contracts.txt` — diffed by me,
157 lines, exact match after whitespace normalisation. No field renamed,
retyped or removed. 36 objections are filed in `CONTRACTS-DISPUTES.md` with
lane detail in `docs/disputes/L*.md`, each stating what was built instead
(always: the contract as written), and five defects found in already-frozen
code are recorded and closed. This is exemplary.

Two soft spots, both already filed as objections rather than drift:
`Finding.locus` extended three different ways (objection 13), and
`SceneMeasurement.boxes` unable to express `textOverflow`, which is the contract
gap under F6 and is *not* in the register.

### 2. Determinism — **PASS**, proven

`scripts/lint-determinism.mjs` clean. Only three quarantined lines in `src/`,
all justified (two presenter stopwatches, one studio wall clock injected as a
parameter). `node scripts/build.mjs --verify-repeat`: three outputs
byte-identical across two builds.

My own proof, emitted from four **separate processes**, one with a different
timezone and locale (`.tmp/critic/27-emit-once.mjs`):

```
f93e6b2959e714be38c0b77c5590c56ebbd2752bfd52d1a2c03729e80dd25ffb 532704
f93e6b2959e714be38c0b77c5590c56ebbd2752bfd52d1a2c03729e80dd25ffb 532704
f93e6b2959e714be38c0b77c5590c56ebbd2752bfd52d1a2c03729e80dd25ffb 532704
TZ=Asia/Tokyo LANG=de_DE.UTF-8:
f93e6b2959e714be38c0b77c5590c56ebbd2752bfd52d1a2c03729e80dd25ffb 532704
```

Not quoted from a test. Proven.

### 3. Colour correctness — **FAIL**

The mathematics is exact and I verified it against published values I supplied
myself (`.tmp/critic/`, inline node):

```
sRGB -> OKLab, Ottosson's published values, max abs error:
  [255,255,255] 3.73e-8   [255,0,0] 3.61e-7   [0,255,0] 4.80e-7   [0,0,255] 2.82e-7
WCAG 2.1:  white/black 21.000000   #777777 on white 4.4781   #0000FF on white 8.5925
relativeLuminance(#808080) 0.215861
worst RGB round-trip error over 4096 samples: 1.063e-11
```

Well inside the 1e-6 tolerance §17.1 demands, and the derivation path works —
`deriveForContrast` produced compliant `border`/`success`/`warning`/`danger` on
the corpus palette and every `FOREGROUND_ROLES` entry cleared 4.5:1.

The axis fails on **F2**. The correctness of the conversion is not the question
a client asks; the question is whether the artifact wears their brand, and it
does not. The solver is handed `#000080` and `#ffa500` — colours read out of
CSS variable *names* — and solves them perfectly.

### 4. Offline integrity — **PASS**

I planted 20 network references into a finished artifact and rescanned
(`.tmp/critic/09-plant-network.mjs`): `<img src>`, `<script src>`, `@import`,
`fetch()`, `sendBeacon`, `new Image().src`, `WebSocket`, `XMLHttpRequest`, CSS
`url()`, SVG `xlink:href`, `<iframe>`, `<form action>`, `<meta refresh>`,
`<link rel=preconnect>`, `EventSource`, dynamic `import()`, `importScripts`,
string-concatenated URLs, and a `data:` -wrapped script — **all caught at
severity 1**. Ten protocol-relative variants, all caught
(`.tmp/critic/10-protocol-relative.mjs`).

One apparent miss was mine: I had spliced the plant at the *first* `</body>`,
which falls inside the pre-rendered payload string. Re-planted at the real body
close (`.tmp/critic/11-recheck.mjs`) it is caught. Treating an inert string
literal as inert is correct behaviour.

Model-level plants (`.tmp/critic/12-model-plants.mjs`): a `MediaRef` whose
`dataUri` is an `https://` URL, and a logo SVG carrying an external `<image
href>`, are both **refused at emit** — the defect `docs/INTEGRATION-NOTES.md`
sent back to L10 is closed. Raw HTML blocks, external `cta` hrefs and presenter
notes containing URLs are stripped and do not reach the file. A URL appearing as
plain headline text is emitted as inert text, which is right.

The browser walk of my artifact recorded **0 network attempts and 0 console
errors** over ~150 key presses, and `verify-offline.mjs` reports the same for
both the platform and fallback decode paths, at 72ms and 76ms FCP.

### 5. Overflow detection efficacy — **FAIL**

Re-measured (§20.5 asks for measurement, not assertion): recall 1.0000 (48/48),
precision 1.0000 (48/48) against an oracle written independently of
`src/validate/`. The infrastructure is genuinely good — the oracle re-implements
segmentation, line breaking and the severity classification, and the thresholds
are cross-asserted.

It fails on **F7**: the 93-case corpus has no `maxLines: 1` case at all, and
**F6**: the class it does not cover is the one that makes four of the eight
layouts unusable on real content. A detector measured at 1.00 on classes the
product never emits, and untested on the class it emits constantly, has not been
measured.

### 6. Branch integrity — **PASS**

`test/branch/return-stack.property.test.mjs` exists and asserts the §17.8
property. I built 11 orphans by hand (`.tmp/critic/18-orphans.mjs`,
`19-unreachable.mjs`) and checked each against `branchCoverage` and
`runPreflight`:

| orphan | caught |
|---|---|
| branch with no scenes | `BRANCH_NO_RETURN` sev 1 |
| branch anchored only by itself | `BRANCH_NO_RETURN` sev 1 |
| two branches anchoring only each other | `BRANCH_NO_RETURN` sev 1 |
| duplicate branch id | `DUPLICATE_SCENE` sev 1 |
| duplicate scene id across spine and branch | `DUPLICATE_SCENE` sev 1 |
| unknown `returnPolicy` | contract refusal |
| no anchor anywhere (still searchable) | `BRANCH_NO_RETURN` sev 2 |
| no anchor **and** no jump entry | `BRANCH_UNREACHABLE` sev 2 + `BRANCH_NO_RETURN` sev 2 — F21 |
| anchor naming a nonexistent branch | **not caught** — F20 |
| branch scene with zero beats | not caught (runtime copes) |
| beat revealing an absent element id | **not caught** — F16 |

The §22.4 stranding cases — a branch that cannot reach the spine, an anchor
cycle — are all caught at severity 1. The reducer unwinds correctly, verified
independently in Node and by real key presses in the browser. The gap is F11
(no key reaches the single-frame return) and the two undetected shapes above,
none of which strand a presenter.

### 7. Provenance enforcement — **PASS**

Twelve routes attempted (`.tmp/critic/20-provenance.mjs`):

```
labelIllustrativeContent = false, mode both            BLOCKED  [PROVENANCE_UNLABELED]
labelIllustrativeContent = false, mode presenter       BLOCKED  22 findings
flip every rendition to verified-by-user, no record    BLOCKED  42 findings
forged record for a DIFFERENT rendition id             BLOCKED  42 findings
forged record with a bad signature                     BLOCKED  42 findings
invalid provenance string                              BLOCKED  contract refusal
emitOptions replaced after normalisation               BLOCKED
options passed as the second argument (3 variants)     BLOCKED
hand-forged VALID promotion record                     emitted  (F23)
```

`normalizeEmitOptions` forces the label true for review-reachable builds, and
the emitter refuses `labelIllustrativeContent: false` **even in presenter mode**,
where normalisation permits it — enforcement at the emitter, not the UI, exactly
as §9 requires.

Rendered check in the browser: the labels are present and visible on 12 of the
35 deck positions, up to 9 at once, computed style
`rgb(255,247,242)` on `rgb(119,118,0)`, `12px`, `opacity: 1`,
`visibility: visible`, 191×38 px, in viewport. See
`.tmp/critic/scene-fanout.png` — every one of the nine locale cards carries
"Illustrative example — not client-approved content".

### 8. Presentation robustness — **PASS**

`.tmp/critic/present.mjs`, `present2.mjs`, headless Chromium, `file://`, every
non-`file://` request aborted.

- **Boot**: 0 requests, 0 page errors, 0 console errors. The browser's
  `data-pp-hash` on first paint equals `stateHash(deck, initialState(deck))`
  computed in Node: `816ccf57ec7e…` both sides.
- **Forward walk**: 16 spine positions, **0 hash divergences** against a
  step-by-step Node simulation of `navigate()`. `→` correctly stops at the end
  of the spine; branches are reachable only by jump, as §11 requires. No
  `.pp-layout--placeholder` at any position.
- **Back-navigation from every beat**: 15 of 15 beats, forward-then-back
  restored the exact state hash, revealed-element count and stage scroll. 0
  failures.
- **Jump index typed character by character**: `/` opens it and focuses the
  input (`activeElement` = `INPUT` with `data-pp-jump-input`); typing
  `a` → `ap` → `app` → `appr` narrows 3 results → 1, ranking
  `Our approvals process would never allow this` first from three characters,
  which is §11's named bar. `Enter` lands on `bn_approvals/sc_d353…/0`.
- **Nested jump and unwind**: spine → `bn_approvals` → walk to its second scene
  → `/claim` → `bn_legal`. Automatic exit at the end of `bn_legal` returns to
  `bn_approvals/sc_bca6…`, then to the spine. `returnTargetFor` agrees.
  `bn_scale` (`nextSpineScene`) exits to the next spine scene. Correct.
- **Blank screen**: `b` blanks; `b` again restores the state hash **exactly**
  (`39a64dd9292a` → `39a64dd9292a`); navigating while blanked advances the beat
  underneath and keeps the blank up.
- **Overlays**: `m` → "Branch map" (475 chars), `c` → "Contents" (192), `?` →
  "Keyboard" (280). `Escape` closes each. `p` opens a real second window titled
  "Presenter view" with current scene, beat, a manual `00:00` timer with
  Start/Reset, the presenter note and the pacing hint labelled *"the deck never
  advances on its own"*.
- `Home`, `End`, `↑`, `↓` all behave.

Nothing required a mouse. No state corruption of any kind. This lane is the
strongest thing in the build.

### 9. Degradation honesty — **FAIL**

F13 (the report double-counts across 32 lines / 15 assets, median prediction
error 1200%, `quality` never moves), F12 (67% of the media payload is
duplicated bytes the budgeter never notices), F17 (159KB of comments in every
artifact while the client's images are resampled to 15%).

What does hold: degradation is monotonic in importance rank at every budget I
tried; the emitted file was within budget every time; below the runtime's own
floor the emitter refuses with `SIZE_BUDGET_EXCEEDED` at severity 1 rather than
silently overshooting; and `EmitResult.bytes` is a true UTF-8 byte count that
matches the file on disk exactly (532,704 = 532,704).

### 10. Studio usability under pressure — **FAIL**

I ran the §1.2 flow end to end in the built studio and it does not reach a file.
Honest account of the run (`.tmp/critic/studio-full.mjs`,
`studio-complete.mjs`):

**What worked.** The studio boots clean from `file://` with 0 errors and 0
network. `Alt+1`…`Alt+8` reach every rail section. `Ctrl+Z` / `Ctrl+Shift+Z`
undo and redo both a field edit and a scene insertion — §15's command stack is
real. `Alt+R` runs the sweep, `Ctrl+Enter` attempts the emit, `Ctrl+K` opens a
command palette, `Alt+/` a keyboard reference. Every layout is offered from a
native `<select>`. Three branches were created from typed objections. The emit
panel states the law plainly: *"there is no override control in this studio, and
the emitter refuses independently of anything this panel does."* Findings are
written for a person under time pressure, name the scene, and say what to do.
Storage pressure is displayed. This is a well-made shell.

**Where it stalls.**

1. **Brand extraction produces nothing** (F1) and says "Brand extracted."
2. **The review gate clears against nothing** (F15): 7 blockers → 2 by one click
   on an empty brand.
3. **Every captured page is un-emittable** (F3): three specimens captured, three
   `ASSET_MISSING` at severity 1, and the offered auto-fix deletes the client's
   image.
4. **No recipe can be run** (F14). The Recipe select stays empty; the only paths
   to a rendition are manual paste and the optional adapter. The eight seed
   recipes — "the reframe payload" — cannot be produced in the studio.
5. **The emit is refused** after the full flow: 6 blocking findings (3
   `ASSET_MISSING`, `TEXT_OVERFLOW` on the specimen's own title at 96.17px over
   a 320px container, and more), reached from a clean project in about twenty
   deliberate steps.
6. The rehearsal panel showed "Scenes walked 0" on a sweep that nonetheless
   reported three findings, before any scene existed — cosmetic but confusing.
7. I could not get the sweep's count to fall by clicking the offered auto-fix
   buttons eight times; the count stayed at 6. I am not certain my clicks
   landed on the intended controls (some sit inside collapsed regions), so I
   report this as **unresolved rather than as a finding**.

**Mouse where a key would do.** `Extract`, `Capture`, `I have checked all of
these`, `Create branch` and the auto-fix buttons have no key binding and are not
in the palette's reach that I could find from typing; I drove them with clicks.
Section navigation, undo/redo, sweep, dry run and emit are all keyed.

**Work lost.** None. Autosave fired on every mutation ("Saved 19 Aug 2026,
01:03"), undo restored across the command stack, and nothing I did lost state.

### 11. Non-goal violations — **PASS**

Searched `src/` and the emitted artifact for all five §1.1 non-goals.

- **Telemetry**: no `analytics`, `beacon`, `gtag`, `mixpanel`, `segment`,
  `amplitude`, `posthog`, `sentry` or pixel anywhere. `fetch` appears only in
  `src/ui/services.js:89`, where the browser's transport is bound and injected,
  and in `src/ingest/fetch.js` for §6 strategies 1–2. The artifact bundle
  contains no `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `sendBeacon`, `localStorage` or `indexedDB`. Browser-verified: 0 requests.
- **Live generation**: `import(` appears 248 times in the bundle, all of them
  inside JSDoc type annotations — checked each context. No `eval`, no
  `new Function`.
- **Integrations**: none.
- **Forecasting / scoring / ROI**: nothing. No sample-stat generator anywhere;
  `assertNoFabricatedFacts` exists as an enforcement point.
- **Backend / accounts**: none. The only endpoint is the §9 optional runtime
  adapter, off by default, its key held in `ProjectStore`'s meta store; I
  grepped the emitted artifact for `adapterKey`, `adapter.key` and
  `Authorization` — **0 hits**.
- **Theme isolation**: `--st-` appears once in the artifact, inside a comment
  explaining why it must not appear. 87 distinct `--pp-` properties.

---

## What is genuinely strong

Worth stating so a fix pass does not damage it.

- **Chrome stripping.** On the corpus home page (mega-nav, utility bar,
  breadcrumbs, sticky bar, cookie dialog, newsletter gate, personalization
  shell, social bar, chat widget, footer nav) the specimen came back at 419
  words across 18 blocks with **zero** leakage of `cookie`, `Accept all`,
  `Newsletter`, `Chat`, `Careers`, `Privacy`, `Sitemap`, `Skip to`,
  `Breadcrumb`, `Investors`, `Follow us` or `LinkedIn`. §22.3 is handled.
- **The runtime.** Zero divergence from an independent state simulation over a
  full walk, exact back-navigation, a return stack that unwinds, an exact
  blank-screen restore, four working overlays and a real presenter window.
- **The network scanner.** 20 planted routes, 20 caught, with correct treatment
  of inert string literals.
- **Provenance at the emitter.** Every route I could invent was refused.
- **The disputes register.** 36 objections, 5 closed defects in frozen code,
  each with what was built instead. This is how a parallel build should record
  itself.

---

## The shortest path to a build that works

In order of leverage, not severity:

1. **Fetch a page's sub-resources on capture** (F1, F3). One change closes the
   two worst findings: the brand engine gets its stylesheet and its logo, and
   specimens get their images. Everything downstream already works — my driver
   proved it by doing nothing but adding that fetch.
2. **Bound the `[a-zA-Z]{3,20}` alternative in `colorTokensIn` to a token that
   is not preceded by `-` or `--`, and collect colours from custom-property
   declarations** (F2).
3. **Grade a `maxLines: 1` + `nowrap` box as truncation, not clipping**, or add
   `textOverflow` to `SceneMeasurement.boxes` so the detector can tell them
   apart — and plant `maxLines: 1` cases in the §17.4 corpus (F6, F7).
4. **Make one lane own the provenance label's colour pair**, and give the solver
   a post-condition over it (F5).
5. **Rewire media refs on the importer path** in `buildSpecimen` (F4).
6. **Drive the fixture corpus from `verify-offline.mjs` and the integration
   test** instead of a proof with no specimens (F24). Every severity-1 finding
   in this report was reachable from a proof built out of the corpus, and none
   was reachable from `makeProof()`.

---

## Reproducing this

```sh
npm run verify                                   # 1625 pass, all four gates clean
node .tmp/critic/pipeline.mjs                    # the corpus, end to end, to a refused emit
node .tmp/critic/build-presentable.mjs           # trims until it emits; writes the artifact
node .tmp/critic/present.mjs                     # keyboard walk, hash-checked against Node
node .tmp/critic/present2.mjs                    # nested jumps, blank, overlays, presenter
node .tmp/critic/studio-complete.mjs             # the §1.2 flow in the built studio
node .tmp/critic/09-plant-network.mjs            # 20 planted network references
node .tmp/critic/18-orphans.mjs                  # 11 branch orphans
node .tmp/critic/20-provenance.mjs               # 12 routes to an unlabelled artifact
node .tmp/critic/22-degrade.mjs                  # forced size budgeting, report audited
node .tmp/critic/24-emit-vs-preflight.mjs        # what emit() refuses vs what preflight blocks
for i in 1 2 3; do node .tmp/critic/27-emit-once.mjs; done   # byte-identical across processes
```

Artifacts produced: `.tmp/critic/northwind.pitchproof.html` (532,704 bytes),
`.tmp/critic/proof-clean.json`, `.tmp/critic/scene-fanout.png`,
`.tmp/critic/scene-with-labels.png`.

Two notes on the working tree. Running the prescribed gate rewrites `dist/` —
the three outputs came back byte-for-byte identical to the committed ones, so
nothing drifted, but a critic's run is not read-only. And `API.md` grew from 683
to 723 lines during this pass (Part 5, "Surfaces the lanes published beyond Part
3"); I did not write it, and the line references above are against the 723-line
version.

## What I did not exercise

Stated plainly, because a critique that overclaims is worse than one with gaps.

- **`.har`, `.mhtml`, saved-page and `.pptx` import**, and the CORS-proxy
  strategy. The corpus does not carry fixtures for them; I drove strategies 1,
  5 and 6 only.
- **The optional runtime adapter** end to end. I verified only that its key is
  absent from the artifact and that `runAdapter` is declared to stamp
  `illustrative`.
- **IndexedDB persistence across a reload**, project export/import round-trip,
  and the 80%-quota pressure path. Autosave and undo/redo I did drive.
- **Dry-run mode** (`Alt+D`) and the heads-up issue counter.
- **A second browser engine.** Everything is Chromium.
- **The auto-fix buttons in the studio panel** — see §20.10 item 7; unresolved,
  not reported as a finding.
- The **`ar-SA` locale rendition** renders LTR Latin text ("Locale format
  contract — Saudi Arabia"). I believe this is correct under §18.2 — inventing
  Arabic copy would be fabrication — but §9.1 asks for "locale-appropriate
  structure, not just translated strings", and I did not judge whether the
  structural differences the template does emit are sufficient.

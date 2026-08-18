# L5 — Brand: type, logo, shape, imagery, theme

Judgment calls the spec did not settle, per §23. Nothing here overrides
`PITCHPROOF-BUILD-SPEC-v1.0.md`; entries follow the style of the root
`DECISIONS.md`.

Lane scope: `src/brand/type.js`, `logo.js`, `shape.js`, `imagery.js`,
`theme.js`. Colour (`color.js` and its modules) is L4's.

---

## L5-D1 — "Modal" radius and border width mean the statistical mode, weighted by selector

**Unsettled by:** §7 asks for "modal border-radius, modal border width" without
defining the statistic or the population.

**Decision.** The reported value is the **weighted mode** of the values a
stylesheet declares, quantized to 1px for radius and 0.5px for border width, with
each declaration weighted by how much its selector looks like a component:
container components (`card`, `modal`, `panel`, `tile`, `popover`, …) weigh 3,
controls (`btn`, `input`, `chip`, `avatar`, …) weigh 2, ordinary selectors weigh
1, and page-level selectors (`*`, `html`, `body`, `:root`) weigh 0.25. Ties break
toward the larger value, then toward the value backed by more distinct selectors.

**Why.** A mean is the wrong statistic: a design with a hundred 8px cards and one
40px promo banner averages to a radius that appears nowhere in the design, and
the artifact would then wear a corner the brand never draws. The mode reports
what the design repeats. The selector weighting exists because a shape language
lives on components — a radius on `blockquote` is decoration, a radius on `.card`
is the system.

**Constants:** `SELECTOR_WEIGHTS`, `DEFAULT_SELECTOR_WEIGHT` in `shape.js`.

---

## L5-D2 — Pills, circles and enormous radii are excluded from the modal radius

**Unsettled by:** §7 says "modal border-radius" and says nothing about
`border-radius: 50%` or the `9999px` pill idiom.

**Decision.** A corner radius at or above 50% of the box, or above 64px absolute,
is dropped from the radius population entirely. Percentages below 50% resolve
against a documented 320px reference box.

**Why.** `border-radius: 50%` makes an avatar a circle and `9999px` makes a chip
a pill; neither is a statement about the design's corners, and both would
otherwise dominate the mode in any design that uses avatars. 50% is the exact
point at which a rectangle's corners meet and it stops being a rounded rectangle.
64px is four times the largest card corner in any mainstream design system
(Material's largest shape corner is 28px, Carbon's is 16px), so nothing a design
means as a corner is caught by the cut.

**Constants:** `PILL_PERCENT`, `PILL_RADIUS_PX`, `PERCENT_BASIS_PX`.

---

## L5-D3 — The shadow tier is anchored to Material Design's published elevations

**Unsettled by:** §7 asks for a "shadow presence tier" and §4 types it `0|1|2|3`
without saying what separates the tiers.

**Decision.** A shadow's strength is

```
geometry = blur/2 + spread + max(|dx|, |dy|)
strength = geometry × min(2, alpha / 0.12)
```

and the tiers are `0` (no shadow), `1` (strength ≤ 4), `2` (≤ 16), `3` (above).
Blur is halved because only about half a Gaussian's radius reads as shadow;
spread and offset count fully because both move the shadow's visible edge; the
alpha factor is referenced to 0.12, the umbra alpha of Material's dp1 shadow, and
capped at 2 so one opaque hairline cannot outrank a real elevation. Inset shadows
describe an inner well rather than elevation and score zero. The brand's tier is
the weighted mode over the rules that declare a shadow, ties breaking upward.

Under this formula Material's own published shadows land at dp1 → 2.5 (tier 1),
dp2 → 8.0 (tier 2), dp16 → 32.7 (tier 3), which is what makes the tiers mean
something outside this repository. `test/brand/shape.test.mjs` asserts exactly
that.

**Why.** Any tier boundary is a choice; a choice anchored to a published ladder
can be argued with, and a bare threshold cannot.

**Constants:** `SHADOW_TIER_BOUNDS`, `SHADOW_REFERENCE_ALPHA`.

---

## L5-D4 — A family that only ever sits behind another in a stack is a fallback, not a face

**Unsettled by:** §7 says to "detect families from `@font-face` rules, inline
styles, and Google Fonts links" without saying what to do with the rest of a
`font-family` stack.

**Decision.** A family is reported as a `TypeFace` only if it appeared at position
0 of some stack, or was named by an `@font-face` rule, a webfont link, or a
user-supplied file. Families that only ever appear behind another family are
fallbacks and are dropped (`detectFaces(..., {includeFallbackFamilies: true})`
keeps them for a studio inspector that wants to show the whole stack).

**Why.** Without the rule, every extraction reports Arial, Helvetica and Georgia
as brand faces, and the "brand system" the user is asked to review becomes noise
they have to clean up before they can trust anything in it.

---

## L5-D5 — Type role is a scored solve over four independent signals

**Unsettled by:** §4 types `TypeFace.role` as `display|body|mono`; §7 does not say
how a role is chosen.

**Decision.** Each family accumulates an additive, inspectable score for each of
the three roles from four signals: what the family itself is (its category from
`core/text-metrics.js`), what generic it sits next to in a stack (a `monospace`
generic is a strong mono signal), what selectors use it (heading / body / code
patterns), and what sizes and weights it is set at. 24px is the display size
boundary — the WCAG 2.1 SC 1.4.3 "large scale" threshold, the only published line
between body and headline sizes. Ties break mono → display → body, most specific
claim first. The per-role scores and the winning margin are kept on the face so
the studio can show its working.

**Why.** A rule chain ("if the selector is an h1 …") is unarguable and brittle;
a score with named terms can be shown to a user and corrected. Body is the
residual role because it is the safe default: a body face used for a headline
looks quiet, a display face used for body copy looks broken.

**Constants:** `DISPLAY_SIZE_PX`, `STRONG_DISPLAY_SIZE_PX`, `BODY_SIZE_RANGE_PX`,
the three selector regexes.

---

## L5-D6 — `metricDelta` is reported at the weight a reader measures

**Unsettled by:** §4 gives `TypeFace.metricDelta` one value; a family has metrics
per weight.

**Decision.** The delta is computed at 400 when the page uses 400, and otherwise
at the weight closest to 400 (ties to the lighter cut). The weight used is kept
on the face as `primaryWeight`.

**Why.** 400 is the weight body copy renders at, and body copy is where a
substitution's width error accumulates into the overflow §22.2 warns about. A
delta taken at 700 would describe the headline and mislead about the paragraph.

---

## L5-D7 — `embeddable` has exactly one gate, and it records who asserted the rights

**Unsettled by:** §7 says `embeddable` is false "unless the user explicitly
supplies a font file they assert they have rights to", without saying what the
assertion is or where it lives.

**Decision.** `detectFaces` can never set `embeddable`. The only function that
can is `attachUserFont(faces, supply, {clock})`, and it throws unless the caller
supplies both a file (bytes or a `data:` URI) **and** a
`rightsAssertion: {assertedBy, statement}`. The assertion is stored on the face
with an `assertedAt` taken from the injected clock. `compileTheme` writes an
`@font-face` rule only for a face that is `embeddable` *and* carries a
`fontFile.dataUri`, and the `src` is always a `data:` URI, so the artifact still
makes no request.

**Why.** §18.2 makes the artifact's honesty an enforced code path rather than a
policy. "Someone asserted this" is only meaningful if the artifact can say who
and when, and a boolean with no provenance is exactly the field that gets flipped
in a hurry the night before a pitch.

---

## L5-D8 — Google Fonts links are parsed, never followed

**Unsettled by:** §7 says to detect Google Fonts links and separately forbids
fetching a foundry's webfont.

**Decision.** Both API versions of the href are parsed for families and weight
axes — v1 (`?family=Open+Sans:400,700|Lora`) and v2
(`?family=Inter:wght@400;700&family=Lora:ital,wght@0,400;1,700`), including
variable ranges written `300..900`. The URL is never requested by any code path
in this lane. A face reached only through a link carries `webfontLinked: true`
and the host it was named by, so the studio can tell the user "this face comes
from Google Fonts and will not be embedded" rather than silently substituting.

---

## L5-D9 — Intrinsic dimensions and transparency come from the asset's own bytes

**Unsettled by:** §7 says "detect transparency" and §4 requires
`LogoAsset.intrinsic`, without saying where either comes from.

**Decision.** Format is identified by magic bytes, never by extension or MIME.
Dimensions come from the PNG `IHDR`, the JPEG `SOFn` frame header, the GIF
logical screen descriptor, the WebP `VP8`/`VP8L`/`VP8X` headers, the BMP
`BITMAPINFOHEADER`, the ICO directory, and — for SVG — the SVG 2 §8.2 rules
(absolute `width`/`height` first, then `viewBox`, then the CSS default replaced
size of 300×150). Transparency comes from the PNG colour type and `tRNS` chunk,
the WebP alpha flag, the GIF graphic-control extension, and the absence of a
full-bleed painted background in an SVG. JPEG is never transparent.

For a PNG that *may* have alpha, the pixels are decoded and the alpha channel is
actually read: an RGBA PNG whose alpha is 255 everywhere has no transparency. The
`transparencyChecked` flag records whether the answer was read or inferred, and
an inferred answer lowers `logos` confidence.

**Why.** `width="200"` in markup is a layout instruction, not a fact about the
asset, and an "it might have alpha" flag sends the studio — and the user — looking
for a background that does not exist.

---

## L5-D10 — A PNG codec is implemented in-lane on `core/inflate.js`

**Unsettled by:** §7 requires transparency detection and inverse generation for
rasters; nothing in `core` decodes an image.

**Decision.** `logo.js` carries a PNG decoder (colour types 0/2/3/4/6, bit depths
1/2/4/8/16, all five scanline filters, `tRNS` colour keys, non-interlaced) built
on `core/inflate.js`, and an encoder (8-bit RGBA, filter 0) built on
`core/deflate.js` and `core/zip.js`'s `crc32`. Interlaced (Adam7) PNGs throw a
named error rather than decoding wrongly. JPEG, GIF and WebP pixels are **not**
decoded, so those formats never produce a generated inverse and say why.

**Why.** Zero npm dependencies is a hard law, and the two things that need pixels
— honest transparency detection and a generated inverse — are exactly the two
places where a wrong answer ships into a client meeting. Adam7 and a JPEG decoder
are both real work whose absence costs a `null` and a reason, while their
half-built presence would cost wrong pixels. Filter 0 on encode keeps the output
a pure function of the input (§5).

---

## L5-D11 — "Monochrome" means one ink, and anything unresolvable fails closed

**Unsettled by:** §7 says to generate an inverse "only when the logo is
monochrome" without defining monochrome.

**Decision.** A mark is monochrome when its paints are one colour, or all
neutral (per-channel spread ≤ 12/255), or all one hue (circular hue spread ≤ 14°,
covering ≥ 98% of opaque pixels for a raster). An SVG containing a gradient, a
paint-server reference, an embedded raster, a `var()`, or any colour keyword this
build cannot resolve is **not** monochrome. A raster in a format this build cannot
decode is not monochrome.

**Why.** The cost of a false negative is a `needsInverseAsset: true` flag and a
studio prompt to ask the client for the reversed lockup. The cost of a false
positive is a machine-recoloured logo in front of the client's brand team. The
asymmetry decides the default.

**Constants:** `ACHROMATIC_CHROMA`, `MONO_HUE_SPREAD_DEG`, `MONO_PIXEL_SHARE`,
`ALPHA_FLOOR`.

---

## L5-D12 — "Luminance inversion" reflects WCAG relative luminance, not OKLab lightness

**Unsettled by:** §7 says "auto-generate an inverse variant by luminance
inversion" without saying which luminance.

**Decision.** Each ink's WCAG 2.1 relative luminance `Y` is reflected to `1 - Y`;
the hue is held and the chroma is clamped back into the sRGB gamut at the new
lightness. The lightness that hits the target luminance is found by bisection on
OKLab L (24 steps), because luminance is monotonic in L at a fixed hue but has no
closed form through the gamut clamp. All colour conversion is L4's
(`brand/color.js`): this lane decides *what* to invert and *to what*, never *how*
a colour converts.

**Why.** Reflecting OKLab lightness instead sends `#111111` to a mid-grey, and a
reversed lockup that is grey on black is a defect, not an inverse. Relative
luminance is also the measure the rest of the product uses for contrast, so
"luminance" means one thing across the codebase. `isLightInk` uses the WCAG
contrast pivot `sqrt(1.05 × 0.05) − 0.05 ≈ 0.1791` — the luminance at which black
and white contrast equally — as its definition of a light ink.

---

## L5-D13 — The imagery classifier takes decoded pixels; it does not decode JPEG

**Unsettled by:** §7 asks for an imagery classifier without saying what it
consumes.

**Decision.** `classifyImagery(images)` takes

```ts
type ImageSample = {
  id?: string;
  width: number; height: number;
  data: Uint8Array | Uint8ClampedArray;   // RGBA, row-major, length = width*height*4
  role?: 'hero'|'content'|'thumbnail'|'logo'|'background';
  weight?: number;                        // defaults to rendered area
};
```

The studio decodes with the platform (`createImageBitmap` + a canvas); Node tests
build buffers directly; PNGs can be decoded in-repo via `sampleFromPng`. Analysis
always runs on a box-averaged copy whose longest edge is 256px, so two captures of
one image at different resolutions cannot disagree.

**Why.** A half-written JPEG decoder produces subtly wrong pixels, and wrong
pixels here become a wrong brand fact the studio then shows the user as extracted.
Box averaging rather than nearest-neighbour matters because nearest-neighbour
preserves the high-frequency noise the edge-density signal is trying to measure.

---

## L5-D14 — Every imagery threshold is exported, named and sourced

**Unsettled by:** §7 names the three signals ("edge density + saturation
distribution + face detection heuristic") but no thresholds.

**Decision.** `IMAGERY_THRESHOLDS` and `IMAGERY_WEIGHTS` in `imagery.js` carry
every constant with its provenance in the docblock. The load-bearing ones:

| Constant | Value | Where it comes from |
|---|---|---|
| `edgeMagnitude` | 0.08 of the Sobel maximum (4×255) | a step of ~20 luma levels across the 3×3 window — the smallest that reads as a boundary rather than 8-bit noise |
| `flatMagnitude` | 0.02 | ~5 luma levels, within the banding a JPEG or a gradient mesh leaves inside an area drawn flat |
| `edgeDensityRamp` | 0.02 → 0.18 | flat vector art sits at the bottom, photographic texture at the top |
| `paletteBits` / `paletteTopBins` | 5 bits per channel, top 8 bins | an illustration concentrates in a chosen palette; a photograph spreads over thousands of bins |
| `vividSaturation` | 0.6 HSV | supporting signal only — a graded photograph is saturated too |
| `skinYCbCr` | Cb ∈ [77,127], Cr ∈ [133,173] | Chai & Ngan, *Face segmentation using skin-color map in videophone applications*, IEEE TCSVT 9(4):551–564, 1999 |
| `skinRgb` | R>95, G>40, B>20, spread>15, \|R−G\|>15, R>G, R>B | Kovac, Peer & Solina, *Human skin color clustering for face detection*, EUROCON 2003 (uniform-daylight rule) |
| `face` geometry | area 0.5–35% of frame, box aspect 0.9–2.2, fill ≥ 0.45 | the proportions of a frontal human head |
| `neutralSaturation` | 0.30 | the anchor `saturationBias = 0` maps to (see L5-D15) |

Both skin rules must agree before a pixel counts, which cuts the false positives
either produces alone on wood, sand and terracotta — and the blob geometry test
then rejects what survives, which is why a terracotta wall is not a portrait.
`test/brand/imagery.test.mjs` asserts that a mid-brown *does* pass both colour
rules, so the geometry test's job is visible rather than assumed.

**Why.** §7 calls the classifier a heuristic. A heuristic whose constants are
anonymous cannot be corrected by the person who knows the brand; a heuristic whose
constants are named, sourced and exported can.

---

## L5-D15 — `saturationBias` is signed about a stated anchor

**Unsettled by:** §4 types `imagery.saturationBias` as a number and gives it no
scale.

**Decision.** `saturationBias` is the area-weighted mean HSV saturation of the
opaque pixels, mapped piecewise-linearly and continuously about
`neutralSaturation = 0.30`: `−1` is fully neutral, `0` is "as saturated as
ordinary photographic imagery", `+1` is fully saturated.

**Why.** "Bias" implies a signed departure from something, and an unsigned 0..1
mean would leave every consumer to invent its own midpoint. The anchor is stated
as a convention rather than dressed up as a measurement: it is the midpoint of the
0.2–0.4 band unmodified photographic imagery's mean saturation falls into, and it
is the one number in the module a brand team is likely to want to move.

---

## L5-D16 — Aggregation weights by rendered area, and `mixed` is half evidence for each class

**Unsettled by:** §7 gives the four treatments but not how several images combine.

**Decision.** Per-image verdicts are aggregated by `weight` (rendered area by
default), an image whose own verdict is `mixed` counts as half evidence for each
class, and the brand is called `photographic` or `illustrative` only when that
class holds ≥ 70% of the decided weight; otherwise `mixed`. An image too small
(< 64 px) or too empty (< 2% opaque) is `unknown` and carries no saturation
evidence. No images at all is `unknown` with confidence 0.

**Why.** It is §7's own instruction for colour — "weight by rendered area, not by
occurrence count" — applied to imagery: a full-bleed hero decides a brand's
imagery treatment and five 64px thumbnails do not.

---

## L5-D17 — Confidence is three named factors per group, never a constant

**Unsettled by:** §7 requires computed confidence "from cluster separation,
sample size, and agreement across sources" — the first of which is colour-specific.

**Decision.** Each group L5 owns computes confidence from the §7 factors that
apply to it:

- **faces** — `0.40 × sample + 0.25 × agreement + 0.35 × substitution`, where
  sample saturates at 6 declarations, agreement saturates at 2 independent
  sources, and substitution is `resolveFace().confidence`, which is exactly "how
  much a fallback substitution moves the metrics". The group score is the
  evidence-weighted mean, discounted to 0.6× when no face is carrying body copy.
- **logos** — `0.55 × best source tier + 0.25 × cross-source agreement +
  0.20 × share whose transparency was read rather than inferred`. The source tier
  is §7's own preference order as a scalar.
- **shape** — per group (radius, border, shadow), `sample × agreement`, averaged
  over the groups that produced evidence and scaled by coverage; sample saturates
  at 12 weighted observations, agreement is the share of weight on the chosen
  value.
- **imagery** — `0.35 × sample + 0.40 × agreement + 0.25 × decisiveness`, where
  decisiveness is the mean margin between the two class scores, so a set of
  borderline images reports low confidence even when they all land on one side.

Colour confidence is L4's. If a caller does not supply it, `buildBrandSystem`
reports **0**, never an invented number.

**Why.** §7 says "never hardcoded". Tests assert that different inputs produce
different confidences, which is the only way to keep that true under maintenance.

---

## L5-D18 — The brand id is content-derived; only `capturedAt` comes from the clock

**Unsettled by:** §5 allows either a seeded PRNG or a content hash for ids.

**Decision.** `BrandSystem.id` is `contentId('brand', …)` over the source URL,
colours, faces, logos, shape and imagery — deliberately excluding `capturedAt`.
Logo ids come from the injected `IdMinter`; a generated inverse's id is
`contentId('logo', {inverseOf, data})` so regenerating it yields the same id
without a minter.

**Why.** A recapture that found the same brand *is* the same brand, and an id that
moved because the clock moved would defeat the deduplication a studio project
needs. `capturedAt` is the field that is supposed to change.

---

## L5-D19 — `compileTheme` emits every variable the runtime stylesheet reads, defaults included

**Unsettled by:** §7 and §15 require the artifact to wear the prospect's brand;
neither says what happens to a property the brand did not produce.

**Decision.** `compileTheme` emits all 23 `--pp-*` properties
`src/runtime/runtime.css` declares or reads, in a fixed order, filling anything
the brand did not produce with the same value the stylesheet would have used
(`THEME_DEFAULTS`). It also emits `--pp-transition-ms`, `--pp-stage-pad` and
`--pp-scale`, which are runtime-owned rather than brand-derived. `assertNoStudioVars`
throws if a `--st-` name ever reaches the output, and the test reads
`runtime.css` to derive the required set rather than restating it.

**Why.** A partial override leaves the artifact's appearance split across two
files, and the next person to change a default in `runtime.css` silently changes
every already-emitted proof's theme. A complete block makes the compiled theme a
full description of how the artifact looks.

---

## L5-D20 — The generated shadow is a fixed near-black, not a brand colour

**Unsettled by:** §7 detects a shadow tier; nothing says what colour the artifact's
shadow is.

**Decision.** `SHADOW_SCALE` compiles each tier to a two-layer shadow in
`rgba(12, 15, 20, α)`, back onto the Material ladder the tiers were detected
against.

**Why.** A shadow tinted with the brand's ink turns into a coloured haze on any
surface that is not white. The tier is a brand fact; the shadow's hue is not, and
inventing one would put a defect on screen that the brand never asked for.

---

## L5-D21 — The CSS rule parser lives in `shape.js`, and `type.js` imports it

**Unsettled by:** the lane owns exactly five files and two of them need to parse
CSS.

**Decision.** `shape.js` owns `parseCssRules`, `parseDeclarations`, `parseLength`
and the value-splitting helpers; `type.js` imports what it needs from there. The
import graph inside the lane is `theme.js → {type, logo, shape, imagery}`,
`type.js → shape.js`, `imagery.js → logo.js`, `logo.js → type.js` (for the DocNode
walkers) — acyclic, which the bundler requires and `scripts/build.mjs` verifies.

**Why.** Two independent CSS parsers in one lane would disagree, and the lane may
not add a sixth file.

---

## L5-D22 — The lane walks L3's `DocNode` shape without importing L3

**Unsettled by:** `API.md` declares `detectFaces(doc, …)` and
`extractLogos(doc, …)` take a `DocNode`, and L3 exports `querySelectorAll`.

**Decision.** L5 implements its own `walkDoc`/`docText`/`serializeNode` over the
`DocNode` shape `API.md` declares, rather than importing L3's selector engine.

**Why.** The two lanes were built in parallel. Depending on L3's implementation
would have made this lane's tests unrunnable until L3 landed, and the node shape —
which is the actual contract — is three fields wide. Nothing here duplicates L3's
parser; it only reads the tree L3 produces.

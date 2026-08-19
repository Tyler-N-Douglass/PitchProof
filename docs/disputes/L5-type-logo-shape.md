# L5 — contract and API disputes

The channel §4 and `API.md` require: a lane that believes a frozen contract or a
declared surface is wrong records the objection here **and builds against it as
written anyway**. Everything below was built as declared.

---

## L5-X1 — `TypeFace.metricDelta` is one triple for a family that has metrics per weight

**Contract:** §4

```ts
metricDelta: { capHeight: number; xHeight: number; avgAdvance: number } | null;
```

**Objection.** A family's advance widths and vertical metrics differ per weight —
Helvetica-Bold is 4.3% wider than Helvetica over the same corpus, and its x-height
is 532 per mille against 523. A single triple therefore describes exactly one
weight, and the contract does not say which. A headline set at 700 and body copy
set at 400 in the same family substitute differently, and §22.2 is precisely about
the case where that difference overflows a container.

**Built as written.** One triple, computed at the weight defined in L5-D6 (400
when the page uses it, otherwise the weight nearest 400), with the weight it was
taken at recorded in the optional field `primaryWeight` and every weight the page
uses already in the contract's `weightsSeen`. Downstream code that needs another
weight can call `metricDelta(family, resolved, weight)` from
`core/text-metrics.js` directly — L11's overflow detector does exactly that, per
box, so nothing depends on the single stored triple for correctness.

**A v2 contract should say** `metricDelta: Record<number, {capHeight, xHeight,
avgAdvance}>` keyed by weight, or add `metricDeltaWeight: number` beside the
existing triple so the stored value is self-describing.

---

## L5-X2 — `LogoAsset` has nowhere to say that a proper inverse asset is needed

**Contract:** §4 `LogoAsset`, and §7: "Auto-generate an inverse variant by
luminance inversion only when the logo is monochrome; otherwise flag that a
proper inverse asset is needed."

**Objection.** §7 requires a flag; §4 provides no field for one. `variant` is a
closed set of five values and none of them means "this mark cannot be
machine-inverted". Without somewhere to put it, the requirement would live only in
a return value that nothing persists, and the studio could not surface it after a
reload.

**Built as written.** No §4 field was renamed or retyped. The flag is carried in
the optional lane extension `needsInverseAsset: boolean`, which §4 explicitly
permits ("lanes may extend with optional fields only"), alongside
`monochrome`, `monochromeKind`, `inkHex` and `monochromeReason` so the studio can
explain *why*. `validateBrand` accepts the extended object with zero errors, and
`test/brand/theme.test.mjs` asserts that.

**A v2 contract should say** `needsInverseAsset: boolean` on `LogoAsset`, or add a
`gaps: string[]` to `BrandSystem` for exactly this class of "extraction succeeded
but a human has to supply something" finding.

---

## L5-X3 — `BrandSystem.imagery.saturationBias` is a bare `number` with no declared scale

**Contract:** §4

```ts
imagery: { treatment: 'photographic'|'illustrative'|'mixed'|'unknown'; saturationBias: number; };
```

**Objection.** Nothing in §4 or §7 says whether this is 0..1, −1..+1, a
multiplier, or a delta, or what zero means. Two lanes reading it would be free to
disagree, and the disagreement would be invisible until an artifact rendered.

**Built as written.** The field is a `number`. Its meaning is defined in L5-D15
and documented in `imagery.js`: signed −1..+1 about a stated anchor of 0.30 mean
HSV saturation, where 0 means "as saturated as ordinary photographic imagery".
`saturationBias()` is exported so any consumer computes it the same way, and the
anchor is an exported constant so it can be moved in one place.

**A v2 contract should say** `saturationBias: number /* -1..1, 0 = photographic
reference */`, or make it an enum, since nothing downstream currently needs
continuous resolution.

---

## L5-X4 — `TypeFace` cannot carry the licence assertion that `embeddable: true` depends on

**Contract:** §4 `TypeFace.embeddable: boolean // true only if a license-clear
webfont file was supplied by the user`, read together with §18.2.

**Objection.** The comment makes the boolean's truth conditional on a fact — a
user supplied a file and asserted the rights — that the contract gives the object
no room to record. A boolean with no provenance is exactly the field that gets
flipped by hand the night before a pitch, and §18 asks for honesty laws built as
enforced code paths rather than documentation.

**Built as written.** `embeddable` stays a boolean and detection never sets it.
The assertion lives in the optional extensions `rightsAssertion: {assertedBy,
statement, assertedAt}` and `fontFile: {fileName, mime, style, bytes, dataUri}`,
set only by `attachUserFont`, which throws without both a file and a named
asserter. `compileTheme` writes an `@font-face` rule only when both are present.

**A v2 contract should say** `embeddable: false | {assertedBy: string; statement:
string; assertedAt: string}` — the shape that makes the honest state
unrepresentable-by-accident.

---

## Non-disputes recorded for the record

- **`shape.shadowLevel: 0|1|2|3`** is a coarse quantisation of a continuous
  quantity, but coarse is right: the artifact needs a shadow, not a shadow
  measurement, and the four tiers map cleanly onto a design system's elevation
  ladder (L5-D3). No objection.
- **`LogoAsset.data: string`** forces raster logos through base64, costing 1.33×.
  D6 already settles that this is the floor for a single-file HTML document, and
  the emitter's budgeting (L10) is where size is managed. No objection.
- **`confidence: Record<'colors'|'faces'|'logos'|'shape'|'imagery', number>`**
  gives one number per group where the studio would like per-field confidence.
  The per-face and per-logo numbers are carried as optional extensions
  (`face.confidence`, and the source tier on each logo), so nothing is lost. No
  objection.

---

## L5-X5 — §4's closed logo variant set makes `primary` double as the residual bucket

**Contract:** §4

```ts
variant: 'primary' | 'mark' | 'wordmark' | 'inverse' | 'favicon';
```

**Objection.** Four of the five values describe an asset's *form* — how it looks.
`primary` describes its *role* — which asset the brand leads with. Mixing the two
in one closed enumeration means any asset whose form matches none of the four
must be called `primary`, and `primary` is the value `logoFor(brand)` defaults
to. The §20 critic's F10 is exactly that failure: a 320×180 og:image of an
industrial plant matched no form band, was therefore labelled `primary`, and
became the logo every layout rendered.

The set also cannot express "an asset was found and judged not to be a logo",
which is a normal and useful outcome on any real site with a social card.

**Built as written.** The enumeration is unchanged. The lane separates the two
meanings itself (L5-D23): exactly one asset is assigned the `primary` role by an
identity score, the rest keep their form-derived variant, and an asset with
neither is not emitted at all. The form each asset would have had is preserved in
the optional extension `formVariant`, and `selectLogos()` returns the rejected
candidates with reasons so the studio can show what was discarded and why.

**A v2 contract should say** either `variant: 'lockup'|'mark'|'wordmark'|'inverse'|'favicon'`
with a separate `role: 'primary'|'secondary'` (or an `isPrimary: boolean`), or add
`'other'` to the set so a found-but-rejected asset has somewhere honest to sit.

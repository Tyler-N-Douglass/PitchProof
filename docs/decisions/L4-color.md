# L4 Brand colour — decisions

Judgment calls the spec did not settle, in `DECISIONS.md` style. Lane scope is
§7 Colour, §17.1, §17.2 and the §22.1 / PLAN §4.1 mitigation. Nothing here
overrides `PITCHPROOF-BUILD-SPEC-v1.0.md` or `API.md`.

---

## L4-D1 — The inverse OKLab matrices are computed, not copied

**Unsettled by:** §7 says "Convert sRGB → linear → OKLab" and §17.1 requires
round-trips to 1e-6, but says nothing about which published constants to use.

**Decision.** The forward matrices (linear sRGB → LMS, LMS → OKLab, XYZ → LMS)
are Björn Ottosson's published values verbatim. Every inverse is computed from
them by Gauss–Jordan elimination at module load rather than copied from his
published rounded inverses.

**Why.** The published inverses are rounded to ten digits, and a rounded inverse
is not an inverse: composing the published forward and published inverse
matrices leaves a residual of about 1e-6, which shows up directly as a 4e-4
error in an 8-bit sRGB round trip — four hundred times the §17.1 budget. With
computed inverses the same round trip is accurate to 3e-12 8-bit units. The
published inverses are kept as exported constants and
`test/brand/color-reference.test.mjs` asserts the computed inverse agrees with
each of them to 1e-7, so both sets of published numbers still constrain the
implementation.

---

## L4-D2 — `relativeLuminance` states the WCAG cutoff, `srgbToLinear` states the IEC one

**Unsettled by:** §7 asks for "WCAG 2.1 relative luminance, computed exactly",
and the WCAG text and the sRGB standard disagree about the transfer function's
breakpoint (0.03928 vs 0.04045 — an erratum in WCAG that was never normatively
corrected).

**Decision.** `relativeLuminance` follows the WCAG text literally, including
0.03928. `srgbToLinear`, which feeds the OKLab pipeline, follows IEC 61966-2-1
with 0.04045. Both constants are named and commented.

**Why.** Each function should be exactly the thing it claims to be. The two
cutoffs bracket no representable 8-bit value — code 10 is below both, code 11
above both — so they cannot disagree on any real colour, and the reference test
asserts equality across all 256 codes. Picking one for both would mean one of
the two functions quietly not matching its own specification.

---

## L4-D3 — The gamut tolerance is 1e-4 8-bit units, and why it is neither tighter nor looser

**Unsettled by:** §7 requires chroma clamping into the sRGB gamut but does not
say what "in gamut" means numerically.

**Decision.** A colour is in gamut when every sRGB channel lies in [0, 255] to
within 1e-4 8-bit units.

**Why.** The bound is squeezed from both sides by measured quantities. It must
be **above** ≈3e-5, because the published matrices do not put `#ffffff` exactly
on the OKLab neutral axis (white lands at b ≈ 3.7e-8), so a pure neutral at
white's own lightness overshoots the blue channel by about 2.7e-5 8-bit units —
a tighter tolerance reports white itself as out of gamut. It must be **far
below** 0.5, the point at which a colour would round to a different 8-bit code:
an early draft used 1/512 and the predicate then called a visibly chromatic
colour "in gamut at L = 0" purely because every channel still rounded to zero.
Conversion noise (3e-12) is nowhere near either bound. Lightness outside the
achievable neutral range is clamped to `SRGB_WHITE_L` / `SRGB_BLACK_L` rather
than to 1 and 0, for the same reason.

---

## L4-D4 — The area model, written down

**Unsettled by:** §7 says "Weight clusters by rendered area, not by occurrence
count" and gives one example, but no model.

**Decision.** Every sample carries a weight in square CSS pixels of *painted*
area:

| source | painted area of one sample |
|---|---|
| fill (`background`, `fill`) | `w · h · alpha` — a box paints its whole border box |
| line (`border-color`, `outline-color`, `stroke`) | `2(w + h) · borderWidth · alpha` — the ring only |
| text (`color`) | `advance · xHeight · INK_DUTY_CYCLE · alpha` |
| image / logo pixel | one pixel, times its alpha |

Gradient stops share the fill they paint. Fully transparent declarations
contribute nothing; translucent ones are composited over the backdrop, because
the eye sees the composite and not the declaration.

**Why.** Text is the only class that has to be modelled rather than measured: a
text run does not paint its line box, it paints glyph strokes inside the
x-height band. The band is `advance · xHeight`, measured through
`core/text-metrics` so it agrees with every other measurement in the product,
and `INK_DUTY_CYCLE` is the inked fraction of that band. That constant is
derived, not chosen: Adobe's Core-14 Helvetica AFM declares `StdVW 88` (stem
width per mille) and the AFM advance of `n` is 556, so a lower-case letter is
two stems in 556 units and the duty cycle is `2 · 88 / 556 ≈ 0.3165`.

---

## L4-D5 — Sources normalise within themselves, then combine by evidential weight

**Unsettled by:** §7 names three collection sources (computed styles, raw CSS,
a quantisation pass over hero imagery and logos) but not how to combine them.

**Decision.** Areas are commensurable *within* a source and not across them, so
each source's areas are normalised to sum to one and the sources are then
combined by an evidential weight: computed 0.45, image 0.25, logo 0.20, css
0.10 (ratio 4.5 : 2.5 : 2 : 1), renormalised over whichever sources are present.

**Why.** A hero screenshot's pixel count and a stylesheet's assumed footprints
are different units; multiplying them together would be arithmetic on
incompatible quantities. The ordering carries the justification: computed styles
are what the browser actually painted; hero imagery is real painted pixels but
carries photographic content that is not brand palette; a logo is the brand's own
declaration of its colours but occupies almost no area, so area weighting alone
would erase it; raw CSS is declared intent with an assumed geometry. Area
ordering therefore holds exactly where it is meaningful and never pretends to
hold where it is not.

---

## L4-D6 — Raw CSS gets explicitly *assumed* footprints, marked as such

**Unsettled by:** §7 requires collecting from raw CSS when computed styles are
unavailable, which means colours with no geometry at all.

**Decision.** A page-ground selector (`html`, `body`, `:root`) with a fill gets
the reference viewport (the `lg` breakpoint from `core/contracts.js`, 1600×900);
any other fill gets one cell of an assumed 3×4 card grid; a text colour gets a
60-character measure over three lines at 16px; a border gets a 1px ring around a
card. Every such sample is flagged `estimated: true`.

**Why.** The alternative — refusing to weight CSS-only colours at all — throws
away the only signal available when CORS blocks a fetch, which §6 says is the
common case. Each constant is the least generous defensible choice: 16px is the
CSS initial `medium` font size in every major engine; 1px is `thin`, the
narrowest painted border, so a declared border can never inflate its share; 60
characters is the midpoint of the classic 45–75 measure. The estimation is
visible in the data rather than hidden, and `confidence.js` prices it through the
source-agreement factor.

---

## L4-D7 — Image pixels are histogrammed, never subsampled

**Unsettled by:** §7 says "a quantization pass over the hero imagery and logo"
without saying how to bound its cost.

**Decision.** Pixels are binned at 5 bits per channel (32³ = 32,768 bins), each
bin reporting the weighted mean of the pixels that fell into it and the count of
those pixels. When an image produces more than 4,096 occupied bins the lightest
are dropped.

**Why.** The first implementation strided the buffer, and the clustering test
caught it doing exactly what stride sampling does: a one-in-four red pattern
sampled every fortieth pixel came back 100% red. Images are full of periodic
patterns — dithering, stripes, UI screenshots, checkerboards — and a fixed
lattice aliases against all of them. A histogram is exact, needs no entropy, is
identical on every machine, and reduces a megapixel hero to a few thousand
samples. Uniform pre-quantisation is the standard first pass of a colour
quantiser, and it costs nothing here because k-means refines centroids from the
accumulated means rather than from bin centres. Dropping the lightest bins
discards the least painted area, which is precisely the quantity the area model
ranks by.

---

## L4-D8 — A cluster's `count` is raw observations, not member samples

**Unsettled by:** §7 says confidence is computed partly from "sample size".

**Decision.** Each sample carries `observations` — one per declaration for style
sources, the pixel count of the bin for image sources — and a cluster's `count`
is the sum. `members` reports how many collected samples fell into it.

**Why.** After L4-D7's binning, the number of samples is a property of the
histogram, not of the evidence. A tightly-clustered image bins down to a handful
of samples and a noisy one to hundreds, so counting samples would have made a
*blurrier* extraction look better evidenced. The confidence test caught this
directly.

---

## L4-D9 — Colourfulness is measured against the hue's cusp, not against the lightness

**Unsettled by:** §7 says "chroma (accents want it, surfaces don't)" without
saying what scale chroma is judged on.

**Decision.** A candidate's `chromaFraction` is its chroma divided by the
largest chroma sRGB can express anywhere at that hue (the hue's cusp), not by
the largest available at its own lightness.

**Why.** This was a real defect before it was a decision. A warm off-white like
`#f7f3ee` carries 30% of the chroma available at its very high lightness, which
qualified it as a brand primary in the "warm retail" fixture, ahead of the brand's
actual orange. Measured against its hue's cusp it carries 5%, which is what the
eye sees, and it is correctly read as a tinted neutral. Cusp-relative measurement
is lightness-independent, which is what "is this colour colourful?" actually
means. The cusp is found by golden-section search over `maxChromaAt` and memoised
per hundredth of a degree — a tenth is too coarse, because the sRGB solid has a
sharp corner near blue where the cusp chroma moves about 0.04 per degree.

---

## L4-D10 — The cost function, its terms, and its weights

**Unsettled by:** §7 names five things the cost function ranges over but gives
neither functional forms nor weights.

**Decision.** Seven terms, weighted:

| term | weight | what it measures |
|---|---|---|
| `contrast` | 3.0 | shortfall of the best achievable foreground against the comfort target, plus a hard penalty when the required floor is unreachable |
| `derived` | 1.5 | one per background slot filled by a synthesised colour |
| `dup` | 2.0 | sum of collision weights over role pairs closer than ΔE 0.02 |
| `order` | 1.2 | distance of the ground from an extreme of lightness, the elevation band between the two surfaces, and the ground-before-alt lightness ordering |
| `chroma` | 1.0 | band violation in band widths, capped at 2 |
| `hue` | 0.8 | primary/accent separation below 30° |
| `area` | 0.8 | shortfall of the chosen colour's area weight, scaled by role |

**Why.** The weights encode a priority order, and the order is the argument for
them. Readability is the product's binding constraint (§22.1), so `contrast`
leads by a factor of two over everything else. Fidelity to the brand's own
colours is the premise of the whole product (§1), and structural distinctness is
what makes a theme visible at all, so those come next. Ordering, chroma, hue and
area are quality preferences that should never outvote a readability or fidelity
argument, and they do not.

Three of the terms have shapes worth stating:

- `dup` is a **sum**, uncapped and not normalised to 0..1. Each additional
  collision must cost more than the last; a normalised term let a palette buy
  its second collision for almost nothing.
- `chroma` violations are measured **in band widths** (`(value − bound) / bound`)
  rather than against the full 0..1 range, capped at two band widths. Against
  the full range the surface bound barely bound anything: a `#42a5f5` page
  ground scored 0.47 where it should have scored 2. The min side is scaled by
  the same cap, so a role that requires chroma and gets none is exactly as wrong
  as a role that forbids chroma and gets twice its budget.
- `contrast` adds `INFEASIBLE_PENALTY = 100` when a background cannot carry a
  legible foreground at the required floor. Finite, not infinite, because the
  search still has to return something and it is the post-condition — never the
  cost function — that refuses a palette.

---

## L4-D11 — The search is exhaustive with branch-and-bound, over a capped pool

**Unsettled by:** PLAN §4.1 requires that the solver "enumerates candidate
assignments" rather than walking a heuristic chain, but not how.

**Decision.** Five roles carry a background (`surface`, `surfaceAlt`, `primary`,
`accent`, `secondary`) and every other role is a function of those five. The
search is a depth-first enumeration of the `pool^5` assignments with
branch-and-bound pruning, over a pool capped at 16 candidates.

**Why.** Every cost term is non-negative, so the sum of per-slot minima is an
admissible lower bound and pruning cannot discard the optimum —
`test/brand/contrast-solve.test.mjs` proves this by running brute force
alongside the pruned search and asserting they agree. Candidates are visited
cheapest-unary-first, which finds a good incumbent immediately: the worst case is
1,048,576 leaves and the observed case is one to three thousand, so a solve takes
about twenty milliseconds. Solving only the five backgrounds and deriving the
rest is what keeps the exponent at five: the nine remaining roles are each a
constrained choice against an already-fixed background, and enumerating them
jointly would buy nothing a post-hoc choice does not already get right.

The five-slot exhaustive search is deterministic without any entropy. The
`brand/derive` substream is drawn from only to break *exact* ties among
equal-cost foreground, border and semantic candidates, so a tie is recorded as a
seeded coin flip rather than hiding as an accident of iteration order.

---

## L4-D12 — The pool carries synthesised anchors and lightness variants

**Unsettled by:** §7 requires derivation for contrast; it does not say whether
the solver may consider colours the brand did not supply.

**Decision.** The candidate pool is the cluster set plus four anchors (pure
white, pure black, and a near-white and near-black carrying the brand's dominant
hue) plus up to six lightness variants of the two heaviest **chromatic**
clusters. All of them are stamped `source: 'derived'` and priced by the fidelity
term.

**Why.** A two-colour brand has five background roles and two colours. Without
synthesised candidates the solver's only options are to collapse two roles onto
one fill or to put a neutral in `primary` — both worse than deriving. The
anchors are found by search rather than chosen: the light anchor is the darkest
colour on the hue line that still reads as white (contrast ≤ 1.1:1 against pure
white) and the dark anchor the lightest that still reads as black (≤ 1.5:1
against pure black); the thresholds differ because the WCAG ratio is compressed
near white by the +0.05 offset and expanded near black. Variant lightnesses are
midpoints (`L/2`, `(L+1)/2`) and the hue's computed cusp — no lightness is
picked by eye. Seeding variants from *chromatic* clusters first matters: seeding
by weight alone spent the budget on greys for the "warm retail" palette, whose
two heaviest colours are both near-white.

---

## L4-D13 — Derived foregrounds hold the background's hue

**Unsettled by:** §7 says to derive "by walking lightness in OKLCH while holding
hue" without saying whose hue.

**Decision.** An `onX` role that no extracted colour can serve is derived from
the background's own hue: `deriveForContrast(bgHex, bgHex, floor)`.

**Why.** It is what design systems do — `onSurface` is a dark tint of the
surface hue — and it keeps the derived colour inside the brand's colour family
rather than dropping a generic black or white into a coloured theme. The walk
searches both directions in lightness and takes the nearer, so the derived colour
moves as little as the constraint allows. Contrast is evaluated on the
**quantised** `#rrggbb` value at every step, so 8-bit rounding cannot drop a
derived colour below the floor after the fact; `DERIVE_MARGIN` (2%) is therefore
insurance against later theme adjustment, not part of the guarantee.

---

## L4-D14 — Border and the semantic roles are held to published thresholds

**Unsettled by:** §4 pairs `border`, `success`, `warning` and `danger` with
`surface` but does not list them in `FOREGROUND_ROLES`, so the spec sets no floor
for them.

**Decision.** `border` is derived or chosen to meet `CONTRAST_AA_NONTEXT` (3:1)
against `surface`, and prefers the least colourful candidate that does.
`success`, `warning` and `danger` are held to the full body floor of 4.5:1
against `surface`, and their canonical hues are the OKLCH hues of the sRGB
primaries themselves — `#ff0000` for danger, `#ffff00` for warning, `#00ff00`
for success.

**Why.** WCAG 1.4.11 requires 3:1 for the boundary of a user-interface
component, which is exactly what a border is, so the published threshold is the
target rather than a subtler hairline. Status colours are status *text* in every
layout that uses them, so holding them to the text floor is the only honest
choice. Taking the hues from the sRGB primaries means no number in the semantic
palette was picked by eye. A brand colour is adopted into a semantic role only
when it is within one hue category (30°, one twelfth of the hue circle) of the
canonical hue *and* at least as colourful as an accent is required to be — a
muted brown sits within one hue category of pure red, but nobody reads it as an
error state.

The border selection weights colourfulness above the whole contrast term
(`BORDER_CHROMA_WEIGHT = 1.5`), so a neutral always beats a vivid candidate that
also meets 3:1. Without it the solver put a hot-pink hairline around every card
on a white ground, which met the threshold and looked broken.

---

## L4-D15 — Confidence is a weighted geometric mean, and unmeasurable factors take the midpoint

**Unsettled by:** §7 names the three inputs to confidence but not the
combination.

**Decision.** `confidence = separation^0.45 · size^0.30 · agreement^0.25`, with
`size = n / (n + 64)` and `agreement` the mean pairwise cosine similarity of the
per-source weight distributions over clusters. A factor that cannot be measured
— one source, so no agreement to observe; one cluster, so no separation to
observe; no sample counts recorded — takes exactly 0.5.

**Why.** Geometric rather than arithmetic because a factor near zero must
collapse the result: a palette with excellent separation, a huge sample and no
corroboration at all is not 0.7 confident, and an arithmetic mean says it is.
Separation leads because it is the only factor that measures whether a palette
exists at all; the other two measure how well it is evidenced. The half-
confidence sample size of 64 is `k_max × 8`: k tops out at 8 (§7) and a centroid
needs on the order of eight members before its standard error falls to about a
third of its cluster's spread. The 0.5 midpoint for unmeasurable factors is the
only value that neither rewards nor punishes; guessing in either direction would
be inventing evidence.

---

## L4-D16 — Silhouette ties go to the smaller k

**Unsettled by:** §7 says k is "chosen by silhouette over k ∈ [3,8]" but not how
to break a tie.

**Decision.** A k only displaces the incumbent if it beats it by more than 1e-9;
otherwise the smaller k wins.

**Why.** Two partitions of equal quality are not equally informative — the more
parsimonious one has actually found structure, while the larger has split a
cluster in half at no cost to the score. The epsilon is far below any difference
that reflects structure and far above double-precision accumulation noise over a
few hundred points.

---

## L4-D17 — Collection refuses to resolve what it cannot see

**Unsettled by:** §7 does not say what to do with `currentColor`, `var(--x)`,
`inherit` or `color-mix()` when only raw CSS is available.

**Decision.** `parseCssColor` returns `null` for every token that cannot be
resolved without a live document, and the collector drops it.

**Why.** A guessed colour enters the palette with the same weight as a measured
one and there is no way to tell them apart afterwards. Dropping it costs one
sample; guessing it can move a cluster centroid and, through it, a role
assignment — and the confidence number would not know to fall.

---

## L4-D18 — A bare colour keyword must be a whole identifier

**Unsettled by:** §7 says to collect colours "from the raw CSS" but not how to
tell a colour token from a word that merely looks like one.

**Decision.** The bare-keyword alternative in `colorTokensIn` is bounded on both
sides so it can only match a complete CSS identifier — not preceded by `-`, `--`
or a word character, and not followed by one — and quoted strings and `url(...)`
payloads are masked out before scanning.

**Why.** This was a severity-1 defect, found by the §20 critic (CRITIQUE-1 F2),
and it is the §22.1 failure in its most literal form. The unbounded pattern
matched `navy` inside `var(--nw-navy)`, `parseCssColor` turned it into HTML navy
`#000080`, and the corpus — whose declared brand is `#0F2A47` navy and `#E8622C`
orange — extracted `primary #000080` and `accent #ffa500`. **Not one extracted
role was a colour the site renders.** The emitted artifact wore HTML defaults
while telling a client "this is your brand", which is a §18 honesty failure as
much as a colour-science one. `-` is excluded on both sides specifically because
it is a legal identifier character and is exactly how design tokens are named.
The same masking stops `background: url("gold-bar.png")` contributing CSS `gold`
and `fill: url(#navy-gradient)` contributing CSS `navy`.

The boundary uses `(^|[^\w-])` with a capture rather than a lookbehind: lookbehind
is ES2018 and the studio has to run in whatever browser the seller has open.

**Test.** `test/brand/color-cluster.test.mjs` asserts twelve token names that
each contain a colour keyword yield nothing. The assertion this replaced used
`var(--y)`, which contains no colour keyword and so could never have caught the
bug — a fixture chosen, accidentally, to miss the failure mode.

---

## L4-D19 — Custom properties are the palette, so they are collected and resolved

**Unsettled by:** §7 lists computed styles, raw CSS and imagery as sources. It
predates the fact that a modern stylesheet keeps its brand in
`:root { --brand-navy: #0F2A47 }` and paints with `var(--brand-navy)`, so the
declaration holding the real value is in neither place the naive reading looks.

**Decision.** `collectFromCss` runs two passes. Pass one builds a
custom-property environment from every sheet. Pass two walks the painting
declarations, resolving `var()` against that environment before looking for
colours. Then:

- a token **referenced** by a painting declaration contributes only through its
  usages, at the area of those usages;
- a token **nothing references** still contributes, at `DECLARED_TOKEN_AREA` —
  the smallest footprint the area model assigns to anything;
- a `var()` that cannot be resolved and carries no fallback contributes
  **nothing**.

Precedence in the environment: an unconditional declaration beats one inside an
at-rule, and within a tier the last in source order wins.

**Why.** Resolving rather than merely harvesting is what makes §7's area
weighting mean anything for a tokenised site: `background: var(--nw-navy)` on the
header and hero should carry the area of a header and a hero, not the area of one
line in `:root`. Counting both the declaration and the usage would double-count
whichever colours happen to be tokenised, which is why a referenced token
contributes only once. An unreferenced token still counts because a declared
design token is the brand stating its own palette and the site may paint with it
from a stylesheet this collector never sees — but it has no geometry at all, so
it gets the weakest footprint in the model rather than an invented one. The
precedence rule keeps a `prefers-color-scheme: dark` override from silently
becoming the default palette; within a tier, last-wins is CSS's own rule at equal
specificity. Refusing an unresolvable `var()` is not conservatism, it is what CSS
itself does: the declaration becomes invalid at computed-value time.

Cycle handling is per branch, not global — `linear-gradient(var(--a), var(--a))`
is a legitimate double use, and only a token that expands into itself is a cycle.
An early version conflated the two and dropped the second reference.

**Test.** On `test/fixtures/corpus/northwind/assets/site.css`, an oracle in the
test scans the file for `#rrggbb` literals and asserts that **every** collected
colour is one of them, that all eight `CORPUS_BRAND` tokens are recovered by
value, and that none of the HTML colours hiding in the token names appears. The
solved palette is checked the same way: no extracted role may be a colour absent
from the file.

---

## L4-D20 — The border and outline shorthands are line properties

**Unsettled by:** nothing in the spec; a consequence of L4-D19.

**Decision.** `border`, `border-top|right|bottom|left`, `border-block`,
`border-inline`, `outline`, `column-rule` and `text-decoration` join the
longhand `*-color` properties as line properties.

**Why.** `border: 1px solid var(--nw-line)` is where a real stylesheet puts its
border colour, and without the shorthands that token was never seen as *used* —
it fell through to the declared-token floor and lost the area weight of every
hairline it actually draws. None of the non-colour keywords a border shorthand
can carry (`solid`, `dashed`, `dotted`, `double`, `groove`, `ridge`, `inset`,
`outset`, `thin`, `medium`, `thick`, `none`, `hidden`) is a CSS named colour, so
the bounded keyword scan of L4-D18 cannot misfire on them.

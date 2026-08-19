# L11 Validate — contract and API objections

The channel §4 and `API.md` require: an objection is recorded here and the lane
**builds against the contract as written anyway**. Nothing in this file changed
`src/core/contracts.d.ts` or any declared surface.

---

## 1. `Finding.locus` cannot name a brand system, a face, a colour role or a beat

**Contract:** §4 — `locus: { sceneId?; branchId?; specimenId?; assetId? }`.

**Objection.** Four of the fourteen codes L11 owns are about things the locus
cannot point at:

- `CONTRAST_FAIL` is about a **colour role pair**. The finding for
  `onPrimary` on `primary` has an empty locus, so the studio cannot deep-link
  the seller to the swatch that is wrong.
- `FONT_UNAVAILABLE` is about a **`TypeFace`**, which has no id in the contract.
- `BEAT_EMPTY` is about a **beat**, and can only say which scene it is in.
- `STALE_CAPTURE` on a `BrandSystem` cannot be expressed at all, which is one of
  the two reasons L11-D9 restricts that rule to specimens.

**What the lane built.** The contract as written. The locus carries only its four
declared keys, and everything else lives in the optional `detail` object §4
permits (L11-D13): `foregroundRole`, `backgroundRole`, `family`, `beatId`,
`beatIndex`. `compactLocus()` drops empty slots so two findings naming the same
place hash identically.

**What a v2 should say.** Widen the locus to an open, ordered address:

```ts
locus: {
  sceneId?: string; branchId?: string; specimenId?: string; assetId?: string;
  renditionId?: string; beatId?: string; faceFamily?: string;
  colorRole?: ColorRole; breakpoint?: 'sm'|'md'|'lg';
}
```

`renditionId` and `breakpoint` are the two that would change behaviour rather
than convenience: the first because provenance is per-rendition and every lane
that touches it has invented its own way to say so (see 2 below), the second
because an overflow at `sm` and the same overflow at `lg` are different defects
with different fixes and currently differ only inside `detail`.

---

## 2. Three lanes independently extended `locus`, in three different ways

**Contract:** §4, as above.

**Observation, not a request.** L10's `provenanceFinding` puts `renditionId` and
a `check` discriminator directly into `locus`; L9 returns coverage `details[]`
alongside the declared arrays; L11 puts everything in a `detail` sibling of
`locus`. All three are legal — §4 permits optional extension — but the same need
was met three ways, which is the signal that the field is under-specified rather
than that any lane was careless.

**What the lane built.** L11 reads L10's `locus.check` to de-duplicate
(L11-D8) and L9's `details[].reasons` to grade severity (L11-D3), and writes its
own extensions into `detail` rather than into `locus`, so the frozen four keys
keep one meaning.

**What a v2 should say.** Pick one. Either widen `locus` (as in 1) or declare
`detail?: Record<string, unknown>` on `Finding` and require the extras to live
there. The present situation — where a consumer must know which lane produced a
finding to know where to look — is the thing to avoid.

---

## 3. `FIXED_SEVERITY` pins three codes and says nothing about the other eleven

**Contract:** `API.md` Part 1 — `FIXED_SEVERITY: Record<string, 1|2|3>`,
"severities no lane may lower". §14 additionally fixes `CONTRAST_FAIL` at
severity 1 for sub-4.5:1 body text, in prose, but the table does not carry it.

**Objection.** The severity of a finding decides whether an emit is refused, and
§14 forbids an override. That makes eleven of the fourteen severities a lane
decision with no mechanical check behind it — precisely the kind of thing §20.1
calls silent contract drift, and precisely the kind that would only be noticed
when a proof that should have been blocked was not.

**What the lane built.** The contract as written, plus a local backstop:
`src/validate/severity.js` declares all fourteen in one table, asserts at load
time that it agrees with `FIXED_SEVERITY` exactly, and refuses through
`resolveSeverity()` any severity outside a documented band. That makes L11's
choices explicit and testable, but it is L11's table, not the contract's.

**What a v2 should say.** Move the full table into `contracts.js`:

```js
DECLARED_SEVERITY: Record<FindingCode, 1|2|3>   // the worst each code can be
NARROWABLE: Record<FindingCode, {floor: 1|2|3}> // where a rule may narrow, and how far
```

`CONTRAST_FAIL: 1` in particular is spec text today and should be a constant.

---

## 4. `SceneMeasurement.boxes` cannot express a box's position, so sibling overflow is invisible

**Surface:** `API.md` Part 3 → L8.

```ts
boxes: { elementId; role; text; style; containerWidthPx; containerHeightPx;
         whiteSpace?; overflowWrap?; maxLines? }[]
```

**Objection.** Every box declares its own container and nothing else. Two real
defects are therefore outside the detector's reach:

- A column of boxes that each fit their own container but together exceed the
  region they share — a headline, a subhead and three paragraphs that overflow
  the panel as a stack while no single one overflows.
- A box clipped by an *ancestor* rather than by its own container.

L8 filed the same objection from its side (`CONTRACTS-DISPUTES.md` #20) and
resolved it as "per-box, as declared; L11 aggregates". L11 cannot aggregate
without knowing which boxes share a region and in what order.

**What the lane built.** The surface as declared. `detectOverflow` measures each
box against its own container on both axes plus the clamp, which is what §22.2
names and what the corpus measures. The gap is recorded rather than papered over.

**What a v2 should say.** Add two optional fields, both of which L8 already knows
when it measures:

```ts
{ …, regionId?: string, orderInRegion?: number, regionHeightPx?: number }
```

With those, one more rule — "the boxes of a region sum past the region" — becomes
possible without changing anything else.

**Update, after the §20 critic.** A third field from the same family has since
landed and is load-bearing: L8 now reports `textOverflow: 'clip' | 'ellipsis'` on
every box, and L11 grades severity on it (L11-D15). Without it the detector could
not tell "clipped, data lost" from "ellipsised by design", and graded the
prospect's own source URL as a blocking defect in four of the eight layouts. The
field exists in the code and is asserted by both lanes' tests; it is **not** in
`API.md`'s `SceneMeasurement` declaration, and it should be:

```ts
boxes: { …, whiteSpace?: string; overflowWrap?: string; maxLines?: number;
         textOverflow?: 'clip'|'ellipsis' }[]
```

It is the field the §22.2 grading turns on, so leaving it undeclared leaves the
most important check in the tool depending on an undocumented agreement between
two lanes.

---

## 5. `runPreflight(proof, {breakpoints?, clock, runtimeJs?, runtimeCss?})` has no place for the rendered document

**Surface:** `API.md` Part 3 → L11 (this lane's own declaration).

**Objection.** §14 lists `NETWORK_REFERENCE` and `PROVENANCE_UNLABELED` among the
codes the rehearsal sweep collects, and both are checks against a *rendered
document*. The declared signature accepts the runtime script and stylesheet but
not the document or the final CSS, so the sweep as declared cannot make either
check against what the artifact will actually contain.

**What the lane built.** The declared signature, with `html` and `css` as
additional optional keys — `API.md` says adding is fine, changing or omitting is
not. Every declared parameter behaves exactly as declared. When `html` is absent
the two document-level checks simply do not run, and the model-level halves of
both still do.

**What a v2 should say.** Declare them:

```js
runPreflight(proof, {breakpoints?, clock, runtimeJs?, runtimeCss?, html?, css?})
```

---

## 6. ~~`hasPromotionRecord` is used by three lanes and declared by none~~ — **closed**

> **Closed.** `API.md` Part 5 now declares `hasPromotionRecord`,
> `verifyProvenance`, `renditionsRequiringLabel` and `PROMOTION_RECORD_RE` on
> `recipe/index.js`, naming L10 and L11 as the reason. The "what a v2 should say"
> block below is what shipped, near enough verbatim.
>
> The objection turned out to be understated. It predicted that three readers of
> one undeclared format were "one format drift away" from a disagreement; the
> drift had already happened. L7 writes a signed, delimited record and L11's
> reader was looking for an English sentence, so preflight raised a **severity-1**
> `PROVENANCE_UNLABELED` against renditions `promoteProvenance` had promoted
> correctly — the studio refused to emit a proof `emit()` was happy with. Reported
> by L10 as L10-D9 and fixed in L11-D19: L11 no longer implements a reader, it
> bridges to L7's through `src/validate/lane-recipe.js`. The record below stands
> as written, and the lesson with it — "a lane imports only declared surfaces" is
> the right rule, and the answer to an undeclared surface another lane owns is to
> get it declared, not to write a second one.

<details>
<summary>The objection as filed</summary>

**Surface:** `API.md` Part 3 → L7 declares `promoteProvenance(rendition, {by,
at})` and says it "records a promotion entry in `rendition.notes`". No reader is
declared anywhere.

**Objection.** L7, L10 and L11 all need to answer "was this promoted?", and all
three now export a function that does. Three readers of one undeclared format is
one format drift away from a proof that L10 refuses and the studio says is fine.

**What the lane built.** L11 implements its own (L11-D7), reading both L7's
`notes` sentence and a structured `promotion: {by, at}` field, and injectable
through `deps.hasPromotionRecord` so the integrator can nominate a single
authority without a code change here. L11 does **not** import L7's, because
`API.md` rule 1 permits imports only of declared surfaces.

**What a v2 should say.** Declare the reader and the format on L7:

```js
hasPromotionRecord(rendition): boolean
promotionRecord(rendition): {by: string, at: string} | null
PROMOTION_RECORD_RE: RegExp
```

and have L10 and L11 import it rather than each carrying a parser.

</details>

---

## Non-disputes, recorded so the critic does not re-derive them

- **`Finding.autoFixAvailable` is a boolean, and one of L11's fixes is neither a
  resolution nor nothing.** `FONT_UNAVAILABLE`'s fix mitigates rather than
  resolves, and two others are plans the emitter carries out (L11-D4). The
  boolean is still the right contract — it answers "is there something to
  offer?" — and the distinction lives on the fix, not on the finding.
- **`Beat.reveals` cannot say a beat deliberately reveals nothing.** L11 infers
  it structurally: a scene where *no* beat reveals anything is the still-frame
  shape the beat engine renders whole, and `BEAT_EMPTY` fires only for a beat
  that reveals nothing inside a scene where others do. That reading needs no
  contract change and is asserted in both directions.
- **`FaceResolution.metricDelta` is nullable, and that is right.** L11 reads it
  through one accessor that returns `number | null` and says "unmeasured" in
  every message rather than quoting a percentage it does not have (L11-D17).
  §22.2's case is the unknown family, so `null` is the answer that matters most.
- **§4 gives no finding code for a `LogoAsset` whose `kind` and payload
  disagree.** `data` is documented as "inline SVG markup or data URI" for either
  kind, so a `kind: 'svg'` logo carrying `data:image/png;…` is contract-legal and
  L11 accepts it (L11-D21). It is a mislabelled kind, not a missing asset, and
  `ASSET_MISSING` — a severity-1 code — is the wrong place to smuggle it in. Not
  filed as a dispute because nothing is blocked: the emitter inlines the payload
  it was given, and the kind field is a hint about the payload rather than a
  promise the artifact relies on. Recorded so the next critic does not read the
  silence as an oversight.
- **`BREAKPOINTS` is a closed list of three.** §14 says "all three breakpoints",
  so this is the spec's decision, not a gap. `runPreflight` still accepts
  explicit geometry so a studio preview at an arbitrary size can be checked, and
  refuses an empty list — measuring at no breakpoint would be an override by
  omission.

# L7 Recipes — contract disputes

Filed per §4 and `CONTRACTS-DISPUTES.md`: a lane that believes a frozen contract
is wrong records the objection here **and builds against the contract as written
anyway**. Everything below is built as written. Nothing here changes
`src/core/contracts.d.ts`.

Format per entry: field, objection, what the lane built instead, and what a v2
contract should say.

---

## DL7-1 — `Rendition` has nowhere to record a promotion

**Field:** `Rendition` (§4, Transformation).

**Objection.** §9 requires that `'verified-by-user'` be reachable only through an
explicit user promotion "that records who promoted it and when", and §22.6 makes
a proof that implies generated content is client-approved *the* reputational risk
in the product. That makes the promotion record a **load-bearing part of the
model**, not an annotation: L10 refuses an emit without it and L11 raises
`PROVENANCE_UNLABELED` from it. But `Rendition` has no field for it. The only
place to put it is `notes: string | null`, which the contract describes as free
text and which the studio UI will let a user edit.

The consequence is concrete. A promotion record living in a user-editable free-
text field can be deleted by a user who is tidying their notes, and the rendition
then claims `'verified-by-user'` with no record — which L10 correctly refuses,
but the user experiences as their proof breaking for no visible reason. The
inverse is worse: the record's integrity rests on a checksum this repository can
compute, so it deters typing but not intent.

A structured field would make the record unforgeable by accident, un-deletable by
tidying, and machine-readable without a regular expression shared between three
lanes.

§20's finding F23 landed on the same point from the other side and is answered
in `docs/decisions/L7-recipes.md` D-L7-17: the digest is as strong as a product
with no backend allows, so the fix there was to stop the *name* implying
otherwise — the parsed field is now `recordIntact`. Note what that leaves for
this dispute. A structured `Rendition.promotion` would not make the record
authenticated either; nothing in a product with no server can. It would fix the
other half: a record a user cannot destroy by tidying their prose, and one no
consumer has to reach through a regular expression to read.

**What the lane built.** The contract as written. The record is encoded in
`notes` as a single delimited line, documented in `docs/decisions/L7-recipes.md`
D-L7-2 and in `src/recipe/provenance.js`, parsed by `readPromotionRecords`, and
checked by `hasPromotionRecord`. `buildRendition` strips any promotion record
found in caller-supplied notes so that only `promoteProvenance` can write one.
No field was added to `Rendition`.

**What a v2 contract should say.**

```ts
export interface Promotion {
  by: string;                 // who promoted it
  at: string;                 // ISO, from the injected clock
  from: Provenance;           // what it was promoted from
}

export interface Rendition {
  // …unchanged…
  provenance: Provenance;
  /** Present if and only if provenance === 'verified-by-user'. */
  promotion?: Promotion | null;
  notes: string | null;       // free text, and only free text
}
```

`Rendition.promotion` is an *optional* field, so §4's "lanes may extend with
optional fields only" arguably already permits it — but adding it unilaterally
would mean L10 and L11 had to know about a field no contract declares, which is
exactly the silent drift §20.1 asks the critic to look for. Hence the dispute
rather than the extension.

---

## DL7-2 — `Rendition.notes` is one free-text field doing two jobs

**Field:** `Rendition.notes: string | null`.

**Objection.** Given DL7-1, `notes` now carries both prose a human wrote and
machine records three lanes parse: the promotion record, the channel-budget
outcome (`[[pp-budget:1;…]]`), and the unsourced-value summary
(`[[pp-unsourced:1;…]]`). Those are different kinds of thing with different
lifetimes and different editability, and putting them in one string means every
consumer needs a parser and every producer needs an escaping rule.

**What the lane built.** The contract as written, with a single namespaced line
convention so the two uses can coexist unambiguously —
`[[pp-<kind>:<version>;<k>=<v>;…]]`, one per line, always after any human prose.
Documented in D-L7-3. `stripPromotionRecords` exists so the studio can show a
user their own prose without the machine lines.

**What a v2 contract should say.** Either `Rendition.promotion` per DL7-1 plus a
`Rendition.marks?: Record<string, unknown>` for lane-written machine records, or
`notes: {text: string | null, marks: Record<string, unknown>}`. Either separates
what a person wrote from what the tool recorded.

---

## DL7-3 — `channelBudget(label)` returns too flat a shape for a real channel

**Field:** `API.md` Part 3 → L7, `channelBudget(label): {maxChars, maxWords}|null`.

**Objection.** No real channel has one length limit. An email has a subject line
that truncates around 60 characters in Outlook and around 41 on an iPhone, a
preheader around 100, and a body with no protocol limit at all. A paid-social ad
has primary text at 125, a headline at 40 and a link description at 30. A single
`maxChars` forces the caller to pick one of those and pretend the others do not
exist, which produces exactly the flattering, unfalsifiable slide §9.2 is trying
to replace with a measured one.

The same applies to `enforceBudget(blocks, budget): {blocks, overBy}`: a single
`overBy` cannot say *which* part is over, and "over by 32" is not actionable
without "the subject line".

**What the lane built.** The declared shape, as a subset. `channelBudget` returns
an object with `maxChars` and `maxWords` exactly as declared, plus `id`,
`channel`, `published`, `parts[]` (each with its own limit and a cited source)
and `sources[]`. `enforceBudget` returns `{blocks, overBy}` exactly as declared,
plus `over`, `parts[]` with per-part character counts, limits, overages, SMS
encoding and segment counts, a ready-to-render `report` table block, and
`structural[]`. A caller written against `API.md` sees the declared shape and
nothing breaks.

**What a v2 contract should say.**

```ts
type BudgetPart = { role: string; name: string; maxChars: number; maxWords: number; source: string };
channelBudget(label): { id, channel, maxChars, maxWords, published: boolean, parts: BudgetPart[] } | null
enforceBudget(blocks, budget, options?): { blocks, overBy, over, parts: BudgetPartReport[], report: ContentBlock }
```

---

## DL7-4 — `runAdapter` is declared as one rendition per call, but every seed recipe is a fan-out

**Field:** `API.md` Part 3 → L7,
`runAdapter(recipe, specimen, {endpoint, key, http}): Promise<Result<Rendition>>`.

**Objection.** Seven of the eight §9 recipes produce more than one rendition:
`locale-fanout` produces nine, `channel-variants` four, `governed-iteration` five.
A signature that returns one `Rendition` means the studio must decide how to
split a fan-out into calls, and there is no parameter in the declared signature
naming *which* of the recipe's `outputLabels` is being asked for. Nine calls to
generate nine locales is also nine round trips a user pays for.

**What the lane built.** The declared signature, returning exactly one
`Rendition`, with an **optional** extra `label` in the config object naming which
of `recipe.outputLabels` to request. When it is omitted the first output label is
used. A caller written against `API.md` gets the declared behaviour.

**What a v2 contract should say.**

```ts
runAdapter(recipe, specimen, {endpoint, key, http, labels?: string[], signal?}): Promise<Result<Rendition[]>>
```

---

## DL7-5 — `Provenance` cannot distinguish "the tool arranged this" from "a model wrote this"

**Field:** `Provenance = 'client-supplied' | 'illustrative' | 'verified-by-user'`.

**Objection.** A `locale-fanout` rendition built by a template is a
*rearrangement of the prospect's own words* — no sentence in it came from
anywhere else. An adapter rendition may be entirely model-authored prose. Both
are `'illustrative'`, and the artifact labels them identically. The second is a
materially larger claim to be making next to a client's logo than the first, and
a viewer who learns the label means "generated" will discount the first
unnecessarily, while a viewer who learns it means "rearranged" will under-read
the second. §22.6 is about exactly this reading.

`producedBy` does distinguish them, and L10 can key off it — which is why this is
a dispute and not a blocker — but `producedBy` describes the *mechanism*, and the
label the artifact renders is driven by `provenance`.

**What the lane built.** The contract as written. Templates produce
`producedBy: 'template'`, the adapter produces `producedBy: 'adapter'`, and both
are `'illustrative'`. `renditionsRequiringLabel` returns both, so nothing is
under-labelled. The distinction is available to L8 and L10 through `producedBy`
if they want to word the label differently.

**What a v2 contract should say.**

```ts
export type Provenance =
  | 'client-supplied'      // the prospect's own content, unmodified
  | 'client-derived'       // rearranged, reformatted or excerpted from the prospect's content — no new words
  | 'illustrative'         // authored by a generator; may contain wording the prospect never wrote
  | 'verified-by-user';
```

with `'client-derived'` still labelled by default, and labelled differently.

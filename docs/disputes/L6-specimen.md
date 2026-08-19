# L6 Specimen — contract and API disputes

Per §4 and the lane rules: objections are recorded here and **the lane builds
against the contract as written anyway**. Nothing in this file changed
`src/core/contracts.d.ts` or a signature in `API.md`.

Format matches `CONTRACTS-DISPUTES.md`: lane, field, objection, what was built,
what a v2 contract should say.

---

## 1. `Specimen` has no field for the untouched source, and §8 requires one

**Lane:** L6 · **Contract:** §4 `Specimen`

**Objection.** §8 states two obligations the interface cannot express: "keep an
untouched `raw` copy of the source HTML per specimen for fallback rendering" and
"never present raw HTML in a scene without a user opt-in per specimen". A
`Specimen` as frozen has nowhere to put either. A lane that follows §8 must
extend the interface; a lane that follows §4 literally must drop a spec
requirement. The same applies to §18.3's "if a specimen was edited, the artifact
says so" — there is no field for the artifact to read.

**What the lane built.** The contract as written, plus optional fields, which §4
explicitly permits: `raw: string|null`, `rawOptIn: {allowed, by, at}`,
`edited: boolean`, `editNotes: string[]`. `rawFallbackBlocks(specimen)` returns
nothing at all unless `rawOptIn.allowed` is true, and only `setRawHtmlOptIn` can
set it, recording who opted in and when. No required field was renamed, retyped
or removed.

**What a v2 contract should say.**

```ts
export interface Specimen {
  // …as frozen…
  /** Untouched source, for fallback rendering only. */
  raw?: string | null;
  /** §8 — raw HTML never renders without this, per specimen. */
  rawOptIn?: { allowed: boolean; by: string | null; at: string | null };
  /** §18.3 — the artifact must say so when this is true. */
  edited?: boolean;
  editNotes?: string[];
}
```

The important half is `edited`. As things stand, an emitter can only honour
§18.3 by trusting a convention between two lanes; as a contract field it is
enforceable at emit, which is where §18 says the honesty laws belong.

---

## 2. `ContentBlock.list` and `ContentBlock.table` cannot express nesting or spans

**Lane:** L6 · **Contract:** §4 `ContentBlock`

**Objection.** `list` carries `items: string[]` and `table` carries
`rows: string[][]`. Real pages nest lists two and three deep (every
documentation page in the corpus does) and merge table cells. Both structures
have to be flattened into strings on the way in, and neither can be restored on
the way out, so a rendition can never be aligned back to the source structure —
which is what L7's block-level paste alignment is for.

**What the lane built.** The contract as written. Nested items are flattened
into the parent list with an em-dash marker per level (D-L6-4), `colspan` is
expanded by repeating the cell and `rowspan` is ignored (D-L6-5).

**What a v2 contract should say.**

```ts
| { type: 'list'; ordered: boolean; items: string[]; depths?: number[] }
| { type: 'table'; rows: string[][]; header: boolean; spans?: {r: number, c: number, rowspan: number, colspan: number}[] }
```

Both are additive and optional, so a v1 consumer reads exactly what it reads
today.

---

## 3. `MediaRef` cannot say that an asset was not downscaled

**Lane:** L6 · **Contract:** §4 `MediaRef`

**Objection.** §8 requires media to be downscaled to a 2400px max edge and
recompressed at `imageQuality`. In a repository with no JPEG encoder, a JPEG can
only be passed through unchanged (D-L6-6). `MediaRef` has `intrinsic` and
`bytes` but no way to record that its intrinsic is still 4000px wide and that
nothing was done about it — so L10's budgeter (§13, "report exactly what was
degraded and by how much — never silently") has to infer it, and §22.5's
size-versus-cold-boot risk lands on an inference.

**What the lane built.** The contract as written, plus optional fields:
`resized`, `recompressed`, `needsDownscale`, `resizeSkipped`, `originalIntrinsic`,
`quality`, `format`, `mime`, `sourceBytes`, `digest`, `sources`, `notes`.
`quality` is `null` whenever nothing was recompressed, so no MediaRef ever
claims a quality it did not apply.

**What a v2 contract should say.**

```ts
export interface MediaRef {
  // …as frozen…
  /** True when this asset still exceeds the capture ceiling. */
  needsDownscale?: boolean;
  /** Why it was not resized, e.g. 'jpeg-no-encoder'. */
  resizeSkipped?: string | null;
}
```

---

## 4. `stripChrome(doc, {siblings})` has no way to say what `siblings` may contain

**Lane:** L6 · **Surface:** API.md Part 3 → L6

**Objection.** The declared signature is `stripChrome(doc, {siblings?})`. It does
not say what a sibling is, and — more dangerously — it does not say that the
page under analysis must not be among them. It is the obvious thing for a caller
to pass "all the pages I captured", and taken literally that makes every block
of the page repeat on itself, so the strongest signal condemns all of them and
the specimen comes back nearly empty. An integration run hit exactly this: 20
blocks and 614 words became 4 blocks and 30 words, silently.

**What the lane built.** The signature as declared, hardened rather than
narrowed: `siblings` accepts parsed `DocNode` roots, `RawCapture` objects
(`{doc}`) or `{root}` wrappers, mixed freely; the page under analysis is
excluded by object identity and by content fingerprint; the exclusion is
reported in the result's `notes`; and a classification that would leave under a
tenth of the page's own text standing re-runs without the repetition signal and
says so (D-L6-12). Callers therefore cannot produce the failure, whether or not
they read this note.

**What a v2 API.md entry should say.**

```js
stripChrome(doc, {siblings?}): {root, removed, how, siblingPages, notes}
// siblings: other pages of the same site — DocNode | RawCapture | {root}.
// The page under analysis is ignored if present.
```


---

## 5. `Specimen.media` cannot express "these two specimens share one asset"

**Lane:** L6 · **Contract:** §4 `Specimen.media: MediaRef[]`, `Proof`

**Objection.** Every specimen carries its own `MediaRef[]`, and a `Proof` has no
asset table. A logo that appears on five captured pages is therefore modelled as
five `MediaRef`s, and the only thing preventing five copies of the bytes in the
artifact is that the runtime happens to key `mediaById` by id. §13 asks the
emitter to budget aggressively against `maxBytes`; with the model as frozen, the
emitter has to reconstruct the sharing relationship by comparing data URIs.

**What the lane built.** The contract as written. Sharing is expressed the only
way it can be — by the same `MediaRef` id and data URI appearing in more than
one specimen's `media` array — produced either at capture through an optional
`MediaLedger` or afterwards by `dedupeMedia` (D-L6-18). No field was renamed,
retyped or removed, and a v1 consumer that iterates `specimen.media` still sees
every asset that specimen uses.

**What a v2 contract should say.**

```ts
export interface Proof {
  // …as frozen…
  /** Assets, stored once; specimens and renditions reference them by id. */
  assets?: MediaRef[];
}
export interface Specimen {
  // …as frozen…
  /** Ids into `Proof.assets`; `media` stays for v1 consumers. */
  mediaIds?: string[];
}
```

An asset table also gives §13's degradation report somewhere honest to count
from: today a budgeter that walks specimens sees one asset n times and can
double-count what it saved by degrading it.

---

## 6. `MediaRef.bytes` does not say which of an asset's three sizes it is

**Lane:** L6 · **Contract:** §4 `MediaRef`

**Objection.** `bytes: number` is the only field in `MediaRef` with no comment,
and it is the only one whose meaning is genuinely ambiguous. An inlined asset
has three sizes — the file the seller supplied, the payload left after §8's
downscale and recompress, and the length of the `dataUri` it is carried as —
and base64 puts a third between the last two. Every neighbouring field is
unambiguous (`dataUri` is annotated, `intrinsic` is in pixels), so a consumer
has no reason to suspect the one number it is most likely to show a user.

That is not hypothetical: the §20 critic's F19 found `bytes` holding the decoded
payload while three studio surfaces displayed it as the size of the asset, each
a uniform 34% short, for as long as the field has existed. A one-line comment on
the frozen contract would have prevented it.

**What the lane built.** The contract as written, with `bytes` resolved to the
inlined cost — `utf8Length(dataUri)`, the same measure `budgetAssets` takes —
and the other two sizes carried in optional fields, `sourceBytes` and
`decodedBytes` (D-L6-19). No field was renamed, retyped or removed, and the type
is unchanged.

**What a v2 contract should say.**

```ts
export interface MediaRef {
  // …as frozen…
  /** What this asset costs the artifact: utf8Length(dataUri), base64 included. */
  bytes: number;
  /** The file as supplied, before downscale or recompression. */
  sourceBytes?: number;
  /** The payload inside the data URI, after downscale and recompression. */
  decodedBytes?: number;
}
```

The comment is the whole of the objection. `bytes` is the number a seller is
shown next to an image in a product whose defining constraint is total size; the
contract should say, in the contract, that it is the size the image contributes.


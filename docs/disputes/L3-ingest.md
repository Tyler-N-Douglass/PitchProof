# CONTRACT DISPUTES — L3 Ingest

The channel §4 and `API.md` require: objections are recorded here, and the lane
**builds against the surface as written anyway**. Nothing in this file changes
`src/core/contracts.d.ts` or `API.md`.

Format per entry: the surface, the objection, what the lane built (always "the
surface as written"), and what a v2 should say.

---

## DL3-1 — `RawCapture.assets` has nowhere to put facts the importer already knows

**Surface.** `API.md` Part 3:
`assets: {name: string, bytes: Uint8Array, mime: string}[]`.

**Objection.** Three importers finish holding facts about an asset that the
contract has no field for, and that the next lane will otherwise have to
recompute or guess:

- the PDF importer knows each image's `/Width` and `/Height` from its XObject
  dictionary, and knows whether an `/SMask` gave it real transparency;
- the OOXML importers know each image's alt text from `wp:docPr/@descr` or
  `p:cNvPr/@descr`;
- the image importer has just measured the intrinsic size to build `meta`.

`MediaRef` (§4) has `alt` and `intrinsic`, so the information is wanted two
steps later — it simply cannot travel in the shape between here and there. L6's
`captureMedia(assets, …)` therefore has to re-derive intrinsic size from the
bytes it was handed, and alt text is lost unless it is smuggled through a
`media` block's `caption`.

**What the lane built.** The declared shape exactly. Alt text travels as the
`caption` of the corresponding `media` block; intrinsic size travels in `meta`
for the single-image strategy and is otherwise re-derivable with the exported
`imageSize(bytes, mime)` helper, which L6 may call. An optional `aliases` field
is added (a legal extension, per D-L3-7) but nothing declared is changed.

**A v2 should say.**
`assets: {name, bytes, mime, alt?: string|null, intrinsic?: {w, h}|null, aliases?: string[]}[]`
— all optional, so no existing producer breaks.

---

## DL3-2 — `ContentBlock.list` cannot express a nested list

**Surface.** §4:
`{ type: 'list'; ordered: boolean; items: string[] }`.

**Objection.** Multi-level bullets are ordinary in both formats this lane
imports. A `.pptx` body placeholder marks depth with `a:pPr/@lvl`; a `.docx`
list marks it with `w:numPr/w:ilvl`. The contract has one flat array, so the
depth has to be either discarded or encoded into the strings.

Encoding it into the strings is not available to this lane: §18.3 says the
prospect's own content is presented unmodified, and prefixing an item with an
em dash or leading spaces to represent a level is a modification the artifact
would then be obliged to disclose. So the depth is discarded, and a two-level
agenda slide renders as a flat list of peers — which subtly misstates the
prospect's own structure on the "before" side of a before/after pair.

**What the lane built.** Flat `items: string[]`, depth discarded, no marker
injected (D-L3-9). The behaviour is asserted by test so it is visible rather
than incidental.

**A v2 should say.** Either
`items: (string | { text: string; level: number })[]`, or add an optional
parallel `levels?: number[]`. Both keep every existing consumer working, since
a plain string array remains valid.

---

## DL3-3 — `DocNode` is declared with a `parent` back-reference, which makes it uncloneable

**Surface.** `API.md` Part 3:
`type DocNode = { type; tag?; attrs?; children?; text?; parent? }`.

**Objection.** `parent` makes every tree cyclic. A `DocNode` therefore cannot be
`JSON.stringify`d, cannot be `structuredClone`d, cannot be posted to a worker,
and cannot be compared with `assert.deepEqual` without care. §8 asks for an
untouched `raw` copy of the source HTML per specimen and §16 stores projects in
IndexedDB — both of which want a serialisable representation, and neither of
which can take the tree as declared.

This is an observation more than a complaint: ancestor walks are needed by the
selector engine's descendant and sibling combinators and by L6's link-density
signal, and a back-reference is the cheapest way to have them. But the
consequence is real and it is not documented in `API.md`.

**What the lane built.** `parent` exactly as declared, plus two exported escape
hatches that add nothing to the declared shape: `plainTree(node)` returns the
same tree with `parent` removed, and `serialize(node)` returns HTML that
round-trips to an identical tree (asserted by test against the hostile fixture).

**A v2 should say.** Keep `parent`, and note in the type's documentation that
`DocNode` is cyclic and must be passed through `plainTree` before serialisation.
No signature change is needed.

---

## DL3-4 — `importOoxml` returns one capture for a whole deck

**Surface.** `API.md` Part 3:
`importOoxml(bytes, {name, clock}): Result<RawCapture>` — singular, where
`importSavedPage`, `importHar` and `importMhtml` all return `RawCapture[]`.

**Objection.** A `.pptx` is closer to a HAR than to a `.docx`: it is n
independent pages in one container. A twelve-slide deck is plausibly twelve
specimens — twelve things a scene could be staged against — and the singular
return type forces them into one, so a user who wants slide 7 as a specimen has
to take all twelve and cut it down by hand later.

**What the lane built.** One `RawCapture` per file, as declared. Slide
boundaries survive in a form a consumer can act on: each slide contributes a
`heading` block, and `meta` carries `slide.<n>.title`, `slide.<n>.part` and
`slide.<n>.notes` so a splitter can be written above this surface without
changing it.

**A v2 should say.** `importOoxml(bytes, {name, clock}): Result<RawCapture[]>`,
with `.docx` returning a single-element array. That would also make all six file
and archive importers agree on one return shape.

---

## Non-disputes recorded for the record

Two things looked wrong on first reading and are not.

- **`discoverSitemap(base, {http})` takes no `clock`**, while §6 says to record
  `capturedAt` on everything. A `SitemapEntry` is a *suggestion*, not a capture —
  nothing has been fetched from the URL yet — so it correctly has no capture
  time. The capture is stamped when the suggestion is followed and `ingestUrl`
  runs. The signature is right as declared, and it has the useful side effect of
  making the ranker structurally incapable of reading a clock (D-L3-15).

- **`Specimen.meta` is `Record<string, string>`**, which forces structured
  metadata (per-slide notes, an `hreflang` map, PDF warnings) into flattened
  dotted keys. This is a real constraint, but a flat string map is also what
  makes `meta` trivially serialisable into an emitted artifact and trivially
  diffable in a test, which are worth more than nesting. The lane namespaces
  every key it adds (`har.*`, `mhtml.*`, `ooxml.*`, `pdf.*`, `slide.*`,
  `savedPage.*`, `image.*`, `pageImages.*`, `hreflang.*`, `http.*`) so no
  importer can shadow a field L6 or L5 reads.

# L8 Scenes — contract and API disputes

Objections to the §4 contracts and to the `API.md` surfaces this lane builds
against. **Every one of them is built against as written**; nothing here was
worked around in code except where a decision is named, and those decisions are
additive.

---

## L8-D1 — `Rendition.notes` carries both an annotation and an audit record

**Surface.** §4 `Rendition.notes: string | null`, plus `API.md` L7:
"`promoteProvenance(rendition, {by, at})` … records a promotion entry in
`rendition.notes`".

**Objection.** One free-text field is being asked to hold two things with
opposite audiences. A note the user wrote ("subject line held to 48 characters
for their ESP") is commentary a client may usefully see, and `sideNote` renders
it. A promotion record ("promoted: verified by t.douglass on 2026-02-03") is the
seller's internal bookkeeping about who signed something off, and putting it on
a slide in front of the client leaks the seller's process into the client's
room. A layout cannot tell them apart except by sniffing the text.

**Built as written.** `Rendition` is untouched. `presentableNotes()` in
`src/scene/parts.js` drops a note that opens with `promoted:` — a string match
against L7's own format — and `test/scene/provenance.test.mjs` asserts no layout
renders a promotion record. This is a filter at the render boundary, not a model
change.

**What would settle it.** A separate optional field for the audit trail
(`promotions: {by, at}[]`), leaving `notes` as user commentary. Either lane can
add it as an optional extension without breaking the frozen shape.

---

## L8-D2 — `SceneMeasurement.boxes` cannot express cumulative overflow

**Surface.** `API.md` L8:
`boxes: { elementId, role, text, style, containerWidthPx, containerHeightPx, whiteSpace?, overflowWrap?, maxLines? }[]`.

**Objection.** The shape describes each run against *its own* container, which
catches "this headline is too wide" and "this clamped blurb is too tall". It
cannot express the failure mode that actually breaks a reskinned layout: eleven
paragraphs that each fit, stacked in one column, whose sum does not. Nothing in
the declared shape says which boxes share a container, so the detector cannot add
them up.

**Built as written.** The declared fields are all present with exactly those
names and meanings. Three optional fields are added — `containerId`, `slot` and
`fontStack` — which `API.md` permits ("Adding exports is fine"). `containerId` is
what makes the sum computable; §22.2's detector can group by it, order by
document order, and compare against `containerHeightPx`.

**What would settle it.** Promoting `containerId` (or an explicit
`containers: {id, widthPx, heightPx}[]` alongside `boxes`) into the declared
shape, so the detector is not relying on an extension.

**Update (CRITIQUE-1 F6).** Half of this is now settled centrally: the
integrator has pinned `textOverflow: 'clip' | 'ellipsis'` into the declared
shape and L11 grades on it. `containerId` is also now *meaningful* rather than
merely present — boxes that stack inside one scrolling column report the same id
(`splitCell:before`, `sideNote:notes`, `indexRow:index`) rather than one id per
element, so the cumulative sum is computable. It remains an extension.

---

## L8-D3 — `measureScene(scene, ctx, breakpoint)` takes the scene twice

**Surface.** `API.md` L8 signature, where `ctx` is a `LayoutContext` and a
`LayoutContext` already carries `scene`.

**Objection.** Two sources for the same value, with no rule for what happens
when they disagree. A caller that passes scene A and a context built for scene B
gets a measurement whose `sceneId` and element ids come from different scenes,
and the mismatch is silent.

**Built as written.** The signature is exactly as declared. `normalizeContext()`
resolves the ambiguity explicitly and documents it: the `scene` argument wins,
`ctx.scene` is a fallback, and a context missing any other field is filled with
neutral values rather than throwing — so a partly-built studio context measures
instead of failing.

**What would settle it.** Either `measureScene(ctx, breakpoint)`, or a note in
`API.md` naming which argument is authoritative.

---

## L8-D4 — `LayoutContext` cannot see the recipes that produced its renditions

**Surface.** `API.md` L2 `LayoutContext = { scene, brand, specimen, renditions,
media, el, labelIllustrative, mode }`; §4 `Rendition.recipeId: string`.

**Objection.** `systemMap` is specified as "a structural diagram of
components/flow", and the component in the middle of every flow this product
shows is the *recipe* — "localise to nine markets", "generate channel variants".
The layout has the `recipeId` but no way to resolve it to the `Recipe.name` or
`Recipe.intent` §4 defines, so the one node the diagram exists to name is the one
node it cannot label. Printing the raw id in front of a client is worse than not
labelling it.

**Built as written.** `systemMap` labels the transform node from
`scene.subhead` when the author gave one, falls back to "Transformation", and
reports the recipe *count* (arithmetic over `renditions`, not a claim, §18.2).
No cross-lane import, no invented name.

**What would settle it.** Adding `recipes: Map<string, Recipe>` to
`LayoutContext` — the runtime already has `proof.recipes` in hand when it builds
the context, so it costs one line at the boundary and no contract change.

---

## L8-D5 — A layout cannot see the breakpoint it will be rendered at

**Surface.** `API.md` L2: a layout is `(LayoutContext) => VNode`, one tree for
every breakpoint; `API.md` L8 requires measurement at three.

**Objection.** Anything a layout decides about *quantity* — how many lines to
clamp, how many list items to lead with, whether a table's fifth column is worth
rendering — has to be one answer for a 390px phone and a 1600px projector. The
right answer differs by a factor of four, and the layout is not allowed to know
which one it is being asked for.

**Built as written.** One tree, no breakpoint dependence. Quantities are chosen
conservatively, every clamp is reported to the detector as `maxLines`, and the
CSS carries the responsive decisions that can be expressed in CSS (column
counts, the stack-at-`sm` arrangement, card height floors). Where a choice
genuinely cannot be made once — nine fan cards at 390px — the geometry reports
the small boxes and the overflow detector says so, which is the honest outcome.

**Why this is probably right anyway.** A per-breakpoint tree would make element
ids, and therefore `Beat.reveals`, breakpoint-dependent — and §10's exact
backward navigation and §17.9's state-hash assertion both rest on a beat's
visible set being a pure function of the beat index. The cost above is the price
of that, and it is worth paying. Recorded here so the trade is visible rather
than discovered.

---

## L8-D6 — `Scene` has nowhere to record how its beats were grouped

**Surface.** §4 `Beat = { id, reveals, presenterNote, dwellHintMs }`.

**Objection.** `buildScene` groups a layout's elements into beats by a narrative
key (`before`, `after/0`, `fan/wave/1`). The key is not in the contract, so once
the scene is built the grouping is gone: a later re-plan (the user adds a
rendition, the studio rebuilds the scene) cannot tell which beats were the
author's own edits and which were generated, and has to regenerate the lot.

**Built as written.** `Beat` is untouched; the group key lives only in the
rendered tree as `data-pp-group`, and `buildScene` re-derives it by rendering.
An explicit `id` argument lets a scene be rebuilt in place so its branches keep
their anchor.

**What would settle it.** An optional `origin?: string` on `Beat` — additive
under §4's "may extend with optional fields only" — recording the group key that
produced it.

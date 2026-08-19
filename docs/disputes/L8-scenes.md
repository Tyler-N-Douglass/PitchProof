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

---

## L8-D7 — §9's law is stated over "renders", and nothing defines it

**Surface.** §9: "Any rendition not marked `client-supplied` or explicitly
promoted … **renders** with a visible, non-removable label in the artifact".
`API.md` L2 `LayoutContext = { scene, brand, specimen, renditions, … }`, where
`renditions` is `scene.renditionIds` resolved.

**Objection.** Three parties read "renders" three different ways and the
contract arbitrates none of them. A **layout** can only see what it was handed —
the renditions the scene declares — and four of the eight then select a subset
to draw. The **emitter** decides it by probing the rendered text for the
rendition's label or a forty-character run of its block text, which is a
heuristic: it says yes when the scene's headline happens to repeat the
rendition's leading heading, and no when the layout drew a rendition's media
with none of its words. A **client in the room** reads it as "is any of this
generated" and does not distinguish at all. A law about the single reputational
risk in the product (§22.6) rests on a word with three meanings.

**Built as written.** Nothing in the contract is changed and the emitter's
predicate is not worked around. L8 satisfies the strictest available reading:
every rendition a scene *declares* that needs a label gets one, on every branch
of every layout, in a `data-pp-rendition` scope of its own
(`withProvenanceLedger` in `src/scene/parts.js`, decision L8-25). That is a
superset of every reading of "renders", so it cannot under-label under any of
them, and it labels the rendition by name so it cannot smear the label onto the
prospect's own content either.

**What would settle it.** Either §9 saying "a rendition a scene declares",
which is what the emitter's own `renditionIds` reading already assumes, or a
`shownRenditionIds` on `Scene` written by whichever lane made the selection —
so the layout, the emitter and the validator answer the question from one field
rather than from three guesses.

---

## L8-D8 — `MeasuredBox.style.family` is the requested face, which SVG cannot use

**Surface.** `API.md` L8 `boxes: { … style … }[]`, with `style.family`; L11
resolves the substitution downstream (`resolveBoxFace` in
`src/validate/overflow.js`). Recorded on this side as decision L8-6.

**Objection.** The division works because CSS breaks its own lines: the layout
reports what it asked for, L11 resolves what will render, and the browser wraps
in whatever it got. `systemMap` is drawn as inline SVG, and SVG has no line
breaking — so *the layout* must break the lines, at author time, and it must
break them against the family that will actually render. The contract gives the
layout the requested family and puts the resolver in the lane that depends on
it, so the one layout that needs the answer before it renders is the one layout
that cannot ask for it.

**Built as written.** `style.family` in every reported box is still the
requested family; L8-6 stands. `renderedFamily()` in
`src/scene/brand-access.js` restates L11's stack walk for `systemMap`'s line
breaking only — the metric model itself is shared, in
`core/text-metrics.resolveFace`, so only the stack-walk rule is in two places.
`test/scene/measure.test.mjs` asserts the two agree on a brand built to
separate them (a declared fallback stack landing on a wider available family
than the metric model would pick).

**What would settle it.** Promoting the face resolution into
`core/text-metrics.js` as one function both lanes call — L11 already imports
`resolveFace` from there, and only the "available families" rule and the
declared-stack walk sit above it. Neither lane needs to own that.

---

## L8-D9 — `core/text-metrics.js` breaks lines after `/` and no browser does

**Surface.** `BREAK_AFTER` in `src/core/text-metrics.js:532` — the set of
characters after which `layoutText` may start a new line. It contains `'/'`.

**Objection.** No browser breaks there. Measured directly in Chromium
(`400 14px/1.35 Arial`, a 200px box):

```
"aaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbb"   Chromium 1 line   model 2
"aaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbb"   Chromium 2 lines  model 2
"aaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbb"   Chromium 1 line   model 1
```

UAX#14 gives `/` the class `SY`, which grants no break opportunity on its own;
`-` is `HY`, which does. The model therefore has strictly *more* places to break
than the page does, packs more text onto each line, and reports fewer lines than
render. That is the one direction §22.2 forbids: it under-reports, so a clamped
run that really loses a line is reported as fitting.

**Measured cost.** Over the emitted corpus artifact, walked in Chromium at all
three `BREAKPOINTS` viewports, every `[data-pp-tx]` box:

```
boxes Chromium genuinely cuts                    126
detected, with BREAK_AFTER as it stands          114     recall 0.9048
detected, with '/' removed from BREAK_AFTER      125     recall 0.9921
```

Every one of the twelve misses is a URL in a scene subhead or headline breaking
after a slash in the model and not in the page. The single residual after the
one-character change is a headline whose longest model line is 348.7px against a
350px box — 0.4%, inside the residual `test/validate/overflow-browser.test.mjs`
already measures and states.

**Built as written.** `src/core/text-metrics.js` is not this lane's file and has
not been touched. Every container `measureScene` reports is now the container
Chromium draws (decision L8-27), so this is the whole of the remaining gap
between L8's measurement and §17.4's number, and it is one character wide.

**What would settle it.** Remove `'/'` from `BREAK_AFTER`. `test/core`'s golden
cases would need re-baselining for any URL-bearing string, and
`test/validate/overflow-browser.test.mjs` is the right place to assert the rule
against Chromium rather than against a table — it already has the harness. The
change should be made by whoever owns `src/core`, not smuggled in through a
scene-lane container width: narrowing a reported container to compensate would
buy the recall number and lose the property decision L8-27 exists to protect.

---

## L8-D10 — Two overflowing runs inside one revealable element collapse to one finding

**Surface.** `detectBoxOverflow` in `src/validate/overflow.js`:

```js
const key = box.elementId || `${box.role || 'text'}#${where.index}`;
```

and `makeFinding({ … key: `${where.breakpoint}|${key}|width` })`, whose `id` is
`contentId('finding', { code, locus, key })`. `sortFindings` keeps one finding
per id.

**Objection.** `elementId` is the nearest *revealable ancestor* — L8 stamps
`data-pp-el` on the thing a beat reveals, which is a panel, a card, a step or a
row, never a single run of text. Every text run inside one of those shares it. So
two runs in the same panel that overflow on the same axis at the same breakpoint
produce the same finding id, and one of them is discarded before anyone sees it.
A panel header is exactly that shape: `panelTitle` and `panelMeta`, side by side,
in one revealable cell.

**Measured cost.** Running `detectBoxOverflow` over the corpus proof's own
measurements and counting the findings `sortFindings` drops:

```
findings suppressed by finding-id collision:  19
  md sc_a668c378d053   panelTitle + panelMeta  (width)   share elementId el_62ed2bfb1e
  sm sc_cfbfda5271de   stepLabel  + bh3        (width)   share elementId el_ce7aa948f7
  sm sc_28aa5e626746   stepLabel  + panelMeta  (width)   share elementId el_c20c25d4e0
  …
```

Against the browser, that is the difference between what the detector *sees* and
what the artifact *reports*: per-box recall 0.9048, per-finding recall 0.770,
over the same run.

**Built as written.** `MeasuredBox` already carries two fields that would
disambiguate — `containerId` and `slot`, both L8 extensions — and the detector
also has `where.index`. This lane did not change L11's key: reporting a null
`elementId` to force the fallback would break the locus every downstream reader
uses, and inventing a per-run `data-pp-el` would make each run individually
revealable, which is a beat-plan change to fix a reporting bug.

**What would settle it.** Include the run in the key rather than only its
revealable ancestor — `${breakpoint}|${elementId ?? role}#${index}|${axis}` is
enough, and `index` is already a parameter. The finding's `locus` and
`detail.elementId` stay exactly as they are, so nothing downstream moves.

---

## L8-D11 — §4 has no way to say which way a block reads

**Surface.** `ContentBlock` and `Rendition` in `src/core/contracts.d.ts`, above
the FROZEN REGION END marker.

**Objection.** §9.1 asks `locale-fanout` for "locale-appropriate structure, not
just translated strings", and writing direction is the most basic structural
fact a locale carries — it is what makes an ar-SA rendition *look* like an ar-SA
page rather than an English page with Arabic-market metadata attached. §4 gives
a block no field for it. The consequence CRITIQUE-2 C8 found is what always
happens when a contract cannot express a fact the product needs: the fact gets
smuggled through a field that can carry anything, in this case escaped HTML in a
`raw` block, and the receiving lane then applies §8's rule about *captured*
source to a rendition the tool produced itself.

**Built as written.** The frozen shapes are untouched. `dir` and `lang` are read
as optional extensions wherever a block or a rendition carries them
(`src/scene/direction.js`), which is the shape L7 already writes them in
(`withDirection` / `carryDirection` in `src/recipe/blocks.js`). Nothing is
guessed: a block that declares neither renders exactly the markup it rendered
before, byte for byte, which `test/scene/direction.test.mjs` asserts over every
layout case.

**What would settle it.** Two optional fields below the FROZEN REGION END
marker, and one line in `API.md`'s §4 summary:

```ts
export interface BlockFlow { dir?: 'ltr' | 'rtl' | 'auto'; lang?: string; }
// ContentBlock and Rendition may carry BlockFlow's fields.
```

They are optional, so no existing proof changes shape, and `validateProofShape`
gains a check that `dir` is one of the three values rather than leaving each
lane to decide what a malformed one means. Until then the fields are a
convention two lanes hold in agreement and nothing enforces, which is the state
this dispute exists to record.

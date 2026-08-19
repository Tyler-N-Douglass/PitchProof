# L8 Scenes — decisions

Judgment calls the spec and `API.md` did not settle, made while building
`src/scene/**`. Format follows `DECISIONS.md`; these are lane-local until they
are merged there at integration. Nothing here overrides
`PITCHPROOF-BUILD-SPEC-v1.0.md`.

---

## L8-1 — Element-id path scheme

**Unsettled by:** §4 makes `Beat.reveals` a list of element ids and `API.md`
gives `ctx.el(path)` a "stable structural path", with `'before/block/3'` as the
only example. Nothing fixes the vocabulary, and L11 and L12 read these ids.

**Decision.** Paths are `/`-separated, lower-case, and describe *structure*,
never content: `<region>[/<kind>/<index>]…`. Indexes are zero-based positions in
the model list the element renders (a specimen block index, a rendition index),
never a running counter over the tree. The full vocabulary, by layout:

| Layout | Paths |
|---|---|
| all | `head` |
| `splitBeforeAfter` | `before/panel`, `before/block/<i>`, `after/rendition/<r>/panel`, `after/rendition/<r>/block/<i>` |
| `fanOut` | `source/panel`, `source/count`, `fan/rendition/<r>` |
| `stack` | `stack/source`, `stack/step/<r>` |
| `fullBleed` | `bleed/media`, `bleed/overlay` |
| `sideNote` | `main/block/<i>`, `note/<k>` |
| `systemMap` | `map/source`, `map/transform`, `map/output/<i>`, `map/output/more`, `map/edge/source`, `map/edge/outputs`, `map/legend/<i>`, `map/arrow` |
| `quoteCard` | `quote/text`, `quote/attribution` |
| `contentsIndex` | `index/entry/<i>` |

`<i>` is a block index in the specimen or in the rendition it belongs to; `<r>`
is the rendition's position in `scene.renditionIds`; `<k>` is the note's
position in the layout's own derived note list.

**Why.** The id is `elementId(sceneId, path)` — a hash — so the path is the only
human-legible handle anyone will ever have on a reveal. Making it structural
means a scene keeps its ids when its content is edited (a headline rewrite does
not renumber the beats), and making the index positional means L11 can say
"`before/block/3` overflows at `sm`" and a user can find the block. `map/arrow`
is a path used for an SVG `<marker>` id rather than a revealable element: it
needs the same stability and the same uniqueness, and minting it any other way
would put a non-deterministic id in the artifact.

---

## L8-2 — The beat plan is derived from the render, not written beside it

**Unsettled by:** `API.md` requires `buildScene` to produce beats whose
`reveals` "name element ids the layout actually renders", without saying how
that is guaranteed.

**Decision.** Every revealable element carries `data-pp-group="<key>"` alongside
its `data-pp-el`. `buildScene` renders the layout once, walks the tree, and
makes one beat per group in document order (`collectGroups` in `plan.js`).

**Why.** The alternative — a table of paths per layout kept next to the layout —
is a second description of the same thing, and the two drift the first time a
layout gains an element. Deriving the plan makes "every revealed id exists" and
"reveal order is reading order" true by construction rather than by test, and
the test then checks the property rather than propping it up.

---

## L8-3 — `measureScene` derives its boxes from the rendered tree

**Unsettled by:** `API.md` declares the shape of `SceneMeasurement` and warns
that unmeasured text is invisible to the detector, without saying where the box
list comes from.

**Decision.** `measureScene` renders the layout through the same function the
runtime calls and walks the result. Six attributes carry everything the walk
needs, and each is also what the stylesheet matches on:

| Attribute | Meaning |
|---|---|
| `data-pp-tx="<role>"` | this element is a text run of that type role; `scenes.css` styles the same selector |
| `data-pp-box="<slot>"` | starts a new container, sized by `boxGeometry(slot, bp, params)` |
| `data-pp-n`, `data-pp-unit-w`, `data-pp-unit-h`, `data-pp-variant` | slot parameters (item count, SVG design units, layout variant) |
| `data-pp-frac="<k>"` | this element is one of k equal columns of its container |
| `data-pp-inset="<token>,<token>"` | subtract these geometry tokens from the width |
| `data-pp-ws`, `data-pp-ow`, `data-pp-clamp` | the `white-space`, `overflow-wrap` and `-webkit-line-clamp` the CSS applies, read straight back |

Text roles never nest, and every text node in a layout's output sits inside a
`data-pp-tx` element. `test/scene/measure.test.mjs` walks the tree with an
independent walker and fails on any run that does not come back in the
measurement.

**Why.** §22.2 makes this the highest-value input in the product. A hand-kept
box list is a promise; a walk of the rendered tree is a property. The attributes
double as the CSS hooks so a run cannot be styled one way and measured another.

---

## L8-4 — One token table behind both the stylesheet and the measurement

**Unsettled by:** the brief requires the CSS to define the geometry
`measureScene` reports and the two to agree; the mechanism was open.

**Decision.** `src/scene/tokens.js` holds `GEOM` (geometry per breakpoint) and
`TYPE_ROLES` (the type scale). `sceneVars(bp)` renders them as the `--pp-sc-*`
custom properties `scenes.css` declares — one `:root` block per breakpoint — and
`geometry.js` computes container boxes from the same table.
`test/scene/css-agreement.test.mjs` parses the stylesheet and asserts each
`:root` block declares *exactly* `sceneVars(bp)` and each `[data-pp-tx]` rule
matches its `TYPE_ROLES` entry, value for value. Dimensions a grid produces
rather than a token — equal split columns, equal fan cards — are computed with
the formula `repeat(n, minmax(0,1fr))` plus `gap` actually produces, so the
agreement there is structural.

**Why.** Two lists of numbers maintained by two hands is exactly how an overflow
detector ends up measuring a layout nobody ships.

---

## L8-5 — What `containerHeightPx` means, and the box extensions

**Unsettled by:** `API.md` asks for "the container width and height the CSS
gives it" without saying what that means for a box whose height is content-driven.

**Decision.** `containerWidthPx` is always exact — it is the inner width the CSS
gives the run. `containerHeightPx` is the height the layout *affords* the box,
and the rule is: **a box is afforded a share of the frame only where the CSS
actually constrains it to one.**

- Constrained, so divided: fan cards (`grid-auto-rows: minmax(min, 1fr)`, with
  the floor applied) and stack steps (`flex: 1 1 0`).
- Not constrained, so afforded the frame: split columns and their cells, margin
  notes, index rows. These stack in a column that scrolls; nothing squeezes
  them, so claiming they get a share of the screen is a fiction. It was one, and
  it is what CRITIQUE-1 F6 measured as thirty to sixty blocking findings on
  `splitBeforeAfter` — a five-rendition scene was reporting that its source
  column had a fifth of the screen height, so ordinary prose "overflowed".
- `--pp-sc-panel-head-h` is a `min-height`, not a cap, so a panel header's boxes
  are measured against the column, not against the floor.

Every box additionally carries four optional fields beyond the declared shape:

- `textOverflow: 'clip' | 'ellipsis'` — see L8-22;
- `fontStack` — the CSS stack `style.family` heads, so L11 can resolve
  availability without re-deriving it from the brand;
- `containerId` — the container the box stacks inside. Boxes that share a
  scrolling column report the *same* id (`splitCell:before`,
  `sideNote:notes`, `indexRow:index`), stamped by the layout as
  `data-pp-container`, so the detector can check each box against the column
  *and* sum the column for the cumulative case;
- `slot` — the geometry slot's name, for reporting.

**Why.** A per-box height that pretended to be exact for an auto-height run
would be a fiction, and one that reported zero would make every column
un-checkable. Reporting the frame as the affordance still flags the single run
that cannot fit on screen at all — verified against planted defects: a
3,500-word paragraph in a split column and an unbreakable 200-character token in
a heading are both still severity 1 — and the shared `containerId` gives the
detector what it needs for the case where six runs each fit and their sum does
not. Extensions are additive, which `API.md` explicitly permits.

---

## L8-6 — `style.family` is the requested brand family, not the resolved one

**Unsettled by:** `API.md` says L11 must measure against
`resolveFace(...).resolved`, and also that `measureScene` reports "the TextStyle
that will actually apply".

**Decision.** `style.family` is the brand `TypeFace.family` the CSS names first —
the requested family — with `fontStack` beside it. L11 resolves.

**Why.** The stylesheet says `font-family: var(--pp-font-display)`, which is the
brand's whole stack; the *requested* family is what that stack asks for, and
which member of it renders depends on the machine the artifact is opened on.
Resolving here as well would substitute twice and hide the requested family from
the finding, which is the thing a user has to act on.

---

## L8-7 — Scene chrome is a 1px hairline, not the brand's border width

**Unsettled by:** §7 extracts `shape.borderWidthPx`; §10 says nothing about
which of a scene's rules are the brand's.

**Decision.** The structural chrome of a scene — panel edges, card outlines,
step frames — is drawn at a fixed 1px (`PANEL_BORDER_PX`). `--pp-border-width`
is honoured on content *inside* the panels: table rules, CTA chips, media frames.

**Why.** Geometry has to be exact for §22.2, and a prospect whose shape language
says 4px borders would move every measured container width by 8px. The brand
still shows where it is about the client's content; the frame around it is the
proof's own furniture, and it is one pixel everywhere so the measurement is
true.

---

## L8-8 — `splitBeforeAfter` renders one column per rendition

**Unsettled by:** §4 lets a scene carry any number of `renditionIds`; the layout
is described as "content on the left, the rendition on the right".

**Decision.** The layout renders `1 + renditions.length` aligned columns, all
sharing one row sequence. There is no cap and no tab strip. A scene with nine
renditions renders ten narrow columns, `measureScene` reports the narrow boxes,
and the overflow detector says so.

**Why.** Two renditions side by side against the source is a real and common
comparison (two markets, two channels), and hiding the second behind a tab
defeats the layout's only job. Capping the count would silently drop content
(§18.3); letting the geometry tell the truth turns a bad authoring choice into a
finding before the meeting, with `fanOut` as the layout that scene wanted.

---

## L8-9 — Row alignment is L8's own, not L7's `alignBlocks`

**Unsettled by:** L7 declares `alignBlocks(sourceBlocks, pastedBlocks)`; L8 needs
alignment too.

**Decision.** `src/scene/align.js` implements `alignPair`/`alignColumns` — an LCS
over block signatures with the runs between anchors zipped positionally,
producing *rows* over any number of columns.

**Why.** The two solve different problems. L7 aligns for authoring and returns a
match score the studio shows the user; L8 aligns for rendering and needs rows,
n columns, and no score at all. L8's copy also runs inside the artifact, where a
dependency on the recipe lane would pull the whole recipe library into every
emitted file for a function of forty lines. Cross-lane import would also make
L8's tests depend on a lane landing in the same pass, which §19 explicitly
arranges to avoid.

---

## L8-10 — What a layout will not put in the artifact

**Unsettled by:** §8 makes raw HTML an opt-in, §13 bans network references, §18.3
requires the client's content unmodified. The interaction was open.

**Decision.** Four rules in `blocks.js` and `parts.js`:

1. A `raw` block renders as **text** (tags stripped), never as markup, under a
   visible "Source markup, shown as text" label.
2. A `cta` block renders its **label only**. The `href` never reaches the
   document.
3. A `media` block renders an `<img>` only when its `MediaRef.dataUri` starts
   with `data:`; anything else renders a visible "Image not included in this
   build" frame.
4. Chrome that shows a source URL (panel meta, map nodes) strips the scheme, so
   the artifact's own furniture never carries an absolute URL.

The prospect's *content* is still rendered verbatim, including any URL inside a
paragraph (§18.3). That is the one path by which a URL-like string can enter the
artifact from L8, and it is the client's own words.

**Why.** §8 puts the raw-HTML opt-in in the studio, where a user can look at what
they are enabling; a layout is not where that decision gets made, and rendering
markup from a captured page is also the easiest way to smuggle a network
reference past the emitter. The `href` and the non-`data:` media rules are the
same law from the other side.

---

## L8-11 — Where the provenance label goes, per layout

**Unsettled by:** §9 requires "a visible, non-removable label"; §22.6 puts
enforcement in the emitter; nothing says where in a layout it sits.

**Decision.** `provenanceLabel()` is the single producer, it never carries
`data-pp-el` (an element without that attribute is always visible, so no beat
can hide it), and each layout puts it inside the subtree marked
`data-pp-rendition="<id>"` for the rendition it describes:

| Layout | Placement |
|---|---|
| `splitBeforeAfter` | in the rendition column's header cell |
| `fanOut` | at the foot of the card |
| `stack` | in the step's header row, beside the meta |
| `fullBleed` | in the overlay panel, over the image |
| `sideNote` | at the foot of the note |
| `systemMap` | in the HTML legend chip that numbers the output node |
| `quoteCard` | under the attribution |
| `contentsIndex` | under the entry |

In `stack` the label rides in the header rather than under the content because a
state in a chain is one or two lines tall and a label below the copy would push
that copy out of its own step.

**Why.** "Inside the rendition's subtree" is what makes the label mean something
to the person reading it — a label floating at the bottom of a scene does not say
*which* of four panels is illustrative. The `data-pp-rendition` marker is what
lets L10 check the same property mechanically.

---

## L8-12 — `systemMap` labels its outputs in HTML, not in SVG

**Unsettled by:** §4 makes `systemMap` a diagram; §18.1 makes the label's
computed contrast and size a check the emitter runs against the final stylesheet.

**Decision.** The drawing is inline SVG; the outputs additionally get an HTML
legend under it, one numbered chip per rendition, and the provenance label lives
in the chip.

**Why.** An SVG `<text>` takes `fill`, not `color`, and has no background box, so
a `pp-provenance` element inside the drawing would be a label whose legibility
the emitter cannot verify — and §18.1 is precisely a rule about verified
legibility. The numbered chips also give the presenter something to point at.

---

## L8-13 — `labelIllustrative` is honoured exactly as handed over

**Unsettled by:** §9 says labelling "cannot be disabled for Review-mode builds";
`LayoutContext` carries a single boolean.

**Decision.** Layouts render the label when `ctx.labelIllustrative` is not
`false`, with no second opinion. Forcing it true for a review-reachable build
happens in `normalizeEmitOptions()` (L1) and again at emit (L10), because it is a
property of the *build*, which a layout cannot see.
`test/scene/provenance.test.mjs` asserts both halves: the layout honours the flag,
and the normalisation upstream cannot be talked out of it.

**Why.** Two enforcement points that both think they are the last one is how a
law ends up with a hole between them. The layout's job is to render the label
where it belongs; the build's job is to decide that the label is on.

---

## L8-14 — Layouts do not branch on `ctx.mode`

**Unsettled by:** `LayoutContext` carries `mode: 'presenter'|'review'`.

**Decision.** No layout reads it. The scene a recipient opens in Review is the
scene the room saw in Presenter, pixel for pixel; the only mode-dependent
surface in the artifact is presenter notes, which no layout renders.

**Why.** A proof that says something different to the person it was forwarded to
than to the room it was presented in is the honesty problem §18 exists to
prevent, in miniature. It also keeps the reveal ids and the measurement
mode-invariant, which the tests assert.

---

## L8-15 — Reveal grouping: one beat per item, until there are too many

**Unsettled by:** §10 defines beats; nothing says how a layout should group its
own content into them.

**Decision.** Items reveal one per beat up to a threshold (four for fan cards
and margin notes, five for index entries), and in waves above it — `waveGroup()`
in `parts.js`. `splitBeforeAfter` groups by column, `stack` by state.

**Why.** A presenter walking three variants wants to talk about each one; a
presenter with nine locale cards wants the nine to land, and nine keypresses of
dead air is the opposite of that. The threshold is where "each one" stops being
what the scene is about.

---

## L8-16 — Margin notes spread down rather than piling on one row

**Unsettled by:** nothing in the spec; a consequence of anchoring notes to the
source block they align with.

**Decision.** After anchoring, notes are assigned one per row, never above their
anchor, order preserved (`notesFor` in `side-note.js`).

**Why.** Several renditions annotating the same opening heading would otherwise
stack five cards into row zero and push the client's second paragraph a screen
down. Spreading keeps each note beside its subject without deforming the column
it annotates.

---

## L8-17 — A one-line clamp is `nowrap` plus an ellipsis, and is measured as such

**Unsettled by:** an implementation constraint the spec could not have known
about.

**Decision.** `[data-pp-clamp="1"]` is `white-space: nowrap; text-overflow:
ellipsis`; multi-line clamps use `-webkit-line-clamp`, and every element carrying
one is a child of a **block** container, never of a grid or flex row.
`measureScene` reports `whiteSpace: 'nowrap'` for a one-line clamp.

**Why.** `-webkit-line-clamp` needs `display: -webkit-box`, and a grid or flex
parent blockifies that away — the clamp silently stops working and the text is
cut through the middle of a line instead. Verified in Chromium against the
rendered layouts. The single-line case needs no legacy box at all, and saying so
in the measurement means the detector checks the width, which is the thing that
actually decides whether a one-line label fits.

---

## L8-18 — Motion: two properties, one variable, no keyframes

**Unsettled by:** §10 gives a 240ms budget and requires interruptibility.

**Decision.** The only animated properties under `src/scene/` are `opacity` and
`transform`; the only duration is `var(--pp-transition-ms)`; there are no
`@keyframes`; and `prefers-reduced-motion: reduce` clears transitions and
animations for the whole layout. Content that overruns a fixed-height card fades
out through a mask rather than being cut mid-glyph.
`test/scene/css-agreement.test.mjs` parses the stylesheet and asserts all four.

**Why.** Opacity and transform are the two properties whose interruption cannot
leave a partial state — the element lands wherever the beat engine says it
should be. A keyframe animation can, which is why there are none. The mask is a
visual honesty measure: a clipped card should look clipped, not broken.

---

## L8-19 — Presenter notes coach delivery and assert nothing

**Unsettled by:** §4 gives `Beat.presenterNote` a free string and `buildScene`
generates a default plan.

**Decision.** Generated notes are prompts about *delivery* — when to stop
talking, what to point at, what to let land. They contain no number, no outcome,
no claim about the client's business. A test greps the generated notes for claim
language and fails on it.

**Why.** §18.2 bans the tool inventing metrics and outcomes. A generated
presenter note that said "this saves them four weeks" would be exactly that
violation wearing a friendlier name, and it would be *read aloud*.

---

## L8-20 — Small layout judgments

- **`contentsIndex`** lists the specimen's headings (with the prose that follows
  each as a blurb) and then the scene's renditions. Listing only the headings
  would silently drop the variants the scene carries.
- **`quoteCard`** takes a `quote` block from a rendition, else from the
  specimen, else sets the scene's *headline* as a statement with the header band
  suppressed so the line is said once. It never invents an attribution: there is
  no "— a customer" fallback, because that is the fabricated testimonial §18.2
  forbids.
- **`fanOut`** cards carry the label, the content and the provenance line, and
  deliberately not the `producedBy` meta the other layouts show — a card is
  small, and the room's attention belongs on the client's content in it. Card
  height has a floor (`--pp-sc-fan-card-min-h`) so a nine-card fan at the small
  breakpoint scrolls rather than becoming nine unreadable slivers.
- **`fullBleed`** prefers a rendition's media over the specimen's, because a
  full-bleed scene attached to a rendition is showing the rendition, and
  degrades to a typographic statement rather than an empty box.
- **`systemMap`** wraps its node labels with `layoutText()` from
  `core/text-metrics.js` in the drawing's design units and emits one `<tspan>`
  per line: SVG has no line breaking, and a label that is not broken here is a
  label that runs out of its box on someone's projector. Because the map roles
  are the same size at every breakpoint, the wrapping is one answer for the whole
  document — which is what a single SVG tree rendered at three breakpoints
  requires.
- **A promotion record is never rendered.** `presentableNotes()` drops a
  `notes` value that opens with `promoted:` (L7's audit record). See the dispute.

---

## L8-21 — `buildScene` mints ids two ways, both deterministic

**Unsettled by:** `API.md` gives `buildScene` an optional `idMinter`.

**Decision.** With an `IdMinter`, scene and beat ids come from its named
substream. Without one, they are `contentId('scene'|'beat', …)` over the
layout, the model ids, the headline, the subhead and the beat's group key. An
explicit `id` rebuilds a scene in place, keeping its identity while its content
changes.

**Why.** The studio has a seeded minter and wants ids that survive an edit; a
test, a fixture or a rehearsal rebuild has neither and wants the same scene to
produce the same ids every time. Both routes are deterministic, which is all §5
requires, and the in-place route is what lets a scene be re-planned without
orphaning the branches anchored to it.


---

## L8-22 — `textOverflow` says whether an overflow is visible or silent

**Unsettled by:** `SceneMeasurement.boxes` carried `whiteSpace`, `overflowWrap`
and `maxLines`, from which the detector could tell that a box does not wrap and
holds one line — but not whether the text that does not fit is cut with an
ellipsis the viewer can see or cut with nothing at all. CRITIQUE-1 F6: the
panel meta line's designed one-line ellipsis was graded severity 1 and blocked
the emit on four of eight layouts, on the prospect's own source URL, with no
seller-authored text involved.

**Decision.** Every box carries `textOverflow: 'clip' | 'ellipsis'`, derived
from the same attribute that produces the CSS (`textOverflowOf()` in
`measure.js`):

- a run carrying `data-pp-clamp` is `'ellipsis'` — the one-line rule declares
  `text-overflow: ellipsis` outright and `-webkit-line-clamp` supplies one above
  it;
- everything else is `'clip'`: if it does not fit it is cut, or pushed past the
  frame, with nothing on screen to say so;
- `data-pp-to` lets a layout state the answer directly where it knows better
  than the derivation.

`test/scene/css-agreement.test.mjs` parses the stylesheet and asserts the
declared value for every clamp the layouts stamp, so the reported value cannot
drift from the CSS. The grading is the integrator's, settled centrally:
`'clip'` is severity 1 (data lost silently), `'ellipsis'` is severity 2
(truncated where the viewer can see it happened).

**Why.** The two cases look identical in a measurement and are opposite in
consequence. A clamp is a design decision the layout made on purpose and the
viewer can see the ellipsis; a clip is content the room never learns exists.
Blocking the emit on the first is what forced the critic to shorten the client's
own title and URL to get an artifact at all — which is the tool asking the
prospect's content to change to suit the tool, the exact inversion §18.3 exists
to prevent.

**Measured.** Against the four corpus specimens × eight layouts × three
breakpoints, with the client's content unmodified and no seller text:
**severity 1 went from 328 to 0**, severity 2 to 202, and the planted-defect
cases (a 3,500-word paragraph in a column, an unbreakable 200-character token in
a heading) still raise severity 1.

---

## L8-23 — A source URL label elides its middle, not its end

**Unsettled by:** §18.3 covers the prospect's *content*; a source URL rendered
in a panel header is chrome the layout generates. Nothing says what to do when
it does not fit.

**Decision.** `displayUrl()` drops the scheme and the trailing slash as before,
and above a 48-character budget elides the middle of the path:
`www.northwind-industrial.example/…/conveyor-drive-units`. Where even that does
not fit, the CSS ellipsises and the measurement reports it as a visible
truncation.

**Why.** The two informative ends of a URL are the host and the last path
segment — the slug that says which page this is. Right-truncation, which is what
the CSS does unaided, keeps the host and throws the slug away, so a client sees
the same forty characters on every scene and cannot tell which of their pages is
on screen. The elision is not an edit to their content: it is a label this lane
writes, and the `…` says plainly that something was removed.

---

## L8-24 — The stylesheet's `overflow-wrap` is reported, not assumed

**Unsettled by:** nothing in the spec; found while investigating CRITIQUE-1 F6.

**Decision.** `.pp-table th, .pp-table td { overflow-wrap: break-word }` is
mirrored by `data-pp-ow="break-word"` on every table cell the block renderer
emits, so the measurement reports the wrap the CSS gives it.
`test/scene/css-agreement.test.mjs` asserts that every `overflow-wrap`
declaration in the sheet outside the attribute rules belongs to a selector whose
boxes report it.

**Why.** A column in a narrow panel is often narrower than a single long word,
and the stylesheet already breaks it. Not reporting that made the detector read
a word the browser would have wrapped as an unbreakable horizontal overflow —
a false severity-1 on the client's own table copy.

---

## L8-25 — A scene labels every rendition it declares, not only the one it drew

**Defect it came from:** the corpus proof reached `emit()` and was refused with
two severity-1 `PROVENANCE_UNLABELED` findings, both on `quoteCard` scenes —
*"Scene sc_437d80e0181d renders 1 unscoped rendition(s) needing a provenance
label but has 0 spare .pp-provenance element(s)."*

**Unsettled by:** §9 says an illustrative rendition renders with a visible label.
It does not say what a layout that *selects* owes a rendition it declined to
select. Four of the eight select: `quoteCard` takes one quotation, `fullBleed`
one image, `sideNote` keeps only renditions that produced a note, and `systemMap`
draws five outputs and collapses the rest.

**How the corpus produced it.** Sectioning a real page at heading boundaries
gives a `quoteCard` scene a rendition whose blocks contain no `quote` block.
`pullQuote` then fell through to the specimen's quote — the client's own words —
and rendered no provenance label, while the scene still listed the illustrative
rendition in `renditionIds`. The scene's headline in that proof *was* the
rendition's own leading heading, so it was rendition-derived text on screen with
nothing labelling it. The emitter was right to refuse.

**Decision.** Every rendition a scene declares that needs a provenance label gets
one, on every branch of every layout. Where the layout scopes the rendition and
labels it in place — a fan card, a split column, a stack step, a legend chip, an
index entry — nothing changes. Where it does not, `withProvenanceLedger()` in
`parts.js` appends a **provenance ledger**: one row per remaining rendition,
naming the rendition and carrying the standard label. The row is itself a
`data-pp-rendition` scope, so the label sits inside the subtree of the rendition
it describes exactly like every other label, and it carries no `data-pp-el`, so
no beat can hide it. All eight layouts end in that call.

**Why "declared", not "visibly rendered".** The alternative rule — label a
rendition only when its material is on screen — is the rule the layouts already
had, and it is the rule that failed. A layout cannot evaluate it: `quoteCard`
renders `scene.headline`, and whether that headline came from a rendition is
knowable to L9 and to a text probe in the emitter, but not to the layout. What
a layout *can* evaluate is what the scene declares, and that predicate can only
over-state the presence of illustrative material, never hide it — which is the
right direction for §22.6.

**Why the row names the rendition.** A ledger row appears exactly where the
rendition's own material is *not* under the label. An unnamed label there would
float beside whatever the layout did render, which on `quoteCard` and
`fullBleed` is often the prospect's own page. Marking the client's content
"illustrative" is §18.1 read backwards and would undercut §18.3's "the
prospect's own content is presented unmodified". Naming the rendition makes the
label a statement about that rendition and about nothing else on screen.

**What the ledger costs, and where that is accounted.** The strip is in flow at
the foot of the stage, so everything above it has that much less vertical room.
`withProvenanceLedger` stamps `data-pp-ledger="<rows>"` on the layout root,
`measureScene` carries it down, and `boxGeometry` subtracts `ledgerAllowance(bp)`
— one strip plus the `.pp-layout` gap — from `contentHeightPx` and
`bodyHeightPx` before any slot is computed. Every stretching slot derives from
those two, so one subtraction keeps the whole measurement honest. A ledger deep
enough to wrap onto a second strip is a scene declaring four or more renditions
it never shows; the single-strip allowance under-states that case, and
under-stating the room means reporting overflow rather than hiding it.

**What the audit found in the other seven.** Rendered against eight hostile
scene shapes (a rendition with no quote, none anywhere, a media-only rendition,
a specimen-supplied hero, one rendition of several carrying the image, nine
renditions on a five-output map, an empty rendition, no specimen at all):
`splitBeforeAfter`, `fanOut`, `stack` and `contentsIndex` were clean on all
eight — each gives every rendition a scope of its own and labels it there.
`fullBleed` left renditions unlabelled on six of the eight, `sideNote` on four,
`systemMap` on one (everything past its fifth output node), and `quoteCard` on
all eight. All four are closed by the same change.

---

## L8-26 — `systemMap` breaks its lines in the face the artifact will render in

**Defect it came from:** L10's gate reported a severity-1 `TEXT_OVERFLOW` on
`mapNodeMeta`, 4.7% over at all three breakpoints with `textOverflow: 'clip'` —
a source URL that just stopped, with nothing on screen to say it was cut.

**Unsettled by:** `API.md` L8 has one `measureScene`, and `docs/decisions`
L8-6 fixes `style.family` as the *requested* brand family because L11 resolves
the substitution downstream. That is right for every layout that hands its text
to CSS. `systemMap` is the one layout that does not: SVG has no line breaking,
so the layout computes the breaks itself, once, at author time.

**Decision.** Four changes, all in `systemMap` and the parts it calls.

1. **Lines are trimmed.** `layoutText` measures a wrapped line without the space
   that ended it but returns the string with that space still attached. The
   layout put that string in a `<tspan>`, `measureScene` read it back, and the
   trailing space was measured as part of the run. That was the whole 4.7%: an
   overflow in the measurement that was never on the screen, graded severity 1
   because SVG runs are `clip`.
2. **Breaks are computed post-substitution.** `renderedFamily()` in
   `brand-access.js` applies the same resolution L11 measures against — walk the
   brand's declared stack, take the first family the artifact can count on, else
   let `resolveFace` pick by metric distance — and `wrap()` breaks against that.
   A brand whose stack lands on a family 10% wider than the requested one's
   metric model otherwise gets lines that fit in the studio and run out of their
   node on the projector.
3. **The URL is elided against the map's node, not against a panel column.**
   `URL_LABEL_BUDGET` is sized for a 320px panel meta line; a map node is 172
   design units with two lines to spend. `fitSourceMeta()` shortens the label
   through the real line breaker until it stops truncating, and `displayUrl()`
   now honours its budget past the structural `host/…/slug` elision by taking
   the remainder out of the middle. The budget is not estimated from an average
   advance, because it is not an average that decides: the wrap breaks at
   hyphens and slashes, so 46 characters may take two lines or three.
4. **A cut that still has to happen says so.** Where a label cannot fit even
   after eliding, `wrap()` ellipsises the last line it kept and the layout
   stamps `data-pp-to="ellipsis"` on that run only. SVG has neither a clamp nor
   a `text-overflow`, so without this the label simply stopped — which under
   L8-22's grading is content lost with nothing to show for it, the case §22.2
   exists to block.

**Why `renderedFamily` is stated twice.** L11 depends on L8; L8 cannot import
`resolveBoxFace` back. The half that matters — the metric model and
`resolveFace` — is shared in `core/text-metrics.js`, and only the stack walk is
restated. `test/scene/measure.test.mjs` asserts the two agree on a brand built
to separate them.

**Scope.** This applies to the SVG roles and nothing else. L8-6 stands for every
other layout: CSS breaks its own lines in whatever face it ended up with, so
reporting the requested family there is still the honest answer.

---

## L8-27 — Every text container is a number the stylesheet declares, and Chromium is what checks it

**From:** CRITIQUE-2 C1 — *"the overflow detector misses a third of the text the
artifact actually cuts"*, the report's only severity 1, failing §17.4's
`recall ≥ 0.98` axis.

**Unsettled by:** nothing in the spec. §22.2 says overflow measurement "must
happen post-substitution, at every breakpoint" and says nothing about how the
container handed to the measurement is arrived at. §14 calls the check the most
valuable in the tool.

**What was wrong.** The measurement and the stylesheet agreed with each other
and neither agreed with a browser. `boxGeometry` matched `GEOM`, `scenes.css`
matched `GEOM`, `test/scene/css-agreement.test.mjs` asserted the two matched —
and every one of those checks is a statement about this lane's own arithmetic.
The stylesheet meanwhile sized several text boxes by their *content*: a flex row
whose split depends on how long the sibling's words are is not a number any
table can hold. Measured in Chromium over the emitted corpus artifact, at the
three viewports `BREAKPOINTS` declares, **980 of 2547 text boxes disagreed with
the model by more than a pixel**, the worst by 1259px.

**Decision — three rules, in this order.**

1. **A row that holds text in two places declares both tracks.** Not
   `display: flex` with two shrink-to-fit children; a grid whose second track is
   a `--pp-sc-*` token, opening at `md` exactly like `.pp-side-row` and `.pp-fan`
   already did. Applied to the scene header and its source chip
   (`--pp-sc-head-extra-w`), the stack step's label and meta
   (`--pp-sc-step-meta-w`) and the provenance ledger's name and label
   (`--pp-sc-ledger-label-w`). At `sm` each token is `100%`, which is the second
   item taking a row of its own — the `isProportional()` convention this lane
   already used for `fan-source-w` and `note-w`.
2. **A text element that is not sized by its row says how it differs.** Three
   declarative attributes, read by `collectTextBoxes` and by nothing else:
   `data-pp-width` (this element *is* a declared track — the list marker, the
   stack rail badge, the head chip), `data-pp-max` (a `max-width` the stylesheet
   caps it with — the subhead, the index blurb, the empty state) and
   `data-pp-inset` extended to accept literal px (`.pp-quote`'s rule gutter,
   `.pp-raw`'s, `.pp-empty`'s frame, `.pp-provenance`'s own padding and rule).
   A percentage token contributes zero to an inset and leaves a `data-pp-width`
   unchanged, so a layout never has to know which breakpoint it is on.
3. **The check is a browser, not a second table.** `test/scene/geometry-browser.test.mjs`
   lays every layout out in real Chromium at all three viewports and fails when
   any `data-pp-box` element or any `data-pp-tx` element is drawn to a width the
   model does not report. That is what makes rule 2's literals safe: the guard
   against `14` drifting from `.pp-quote` is no longer a copy of the number, it
   is the rendered box.

Also fixed, all found by the same measurement: `.pp-side-note`'s asymmetric
3px accent rule (`NOTE_RULE_PX`), `stackStep` naming the row that holds the rail
rather than the panel that holds the text, `.pp-panel-head-text` and
`.pp-stack-head-right` sizing to their content instead of filling their track,
`.pp-fan-count` splitting a row between a number and a label, and
`.pp-index-num-text` being an inline box, which has no width for either side to
talk about.

**Result, measured the same way.** Slot geometry: exact at every breakpoint,
every slot, within Chromium's integer rounding. Text containers: **75 of 2547
disagree, and all 75 are the one shape below.** Browser-measured recall over the
emitted corpus artifact rose from **0.653** (the critic's number; 0.672 on my
own harness, which matches per box rather than per role) to **0.906**, with
zero false positives — see L8-D9 for the whole of the remaining gap, which is
one character in a module this lane does not own.

**Why the assertion is the geometry and not the recall.** A recall number is a
fact about one corpus's sentences: rewrite a headline and it moves. "Every
container the model reports is the container the browser draws" is a fact about
the code, it implies the recall, and it fails on the next run rather than in
front of a client.

---

## L8-28 — One shape is a bound rather than an equality, and it is enumerated

**From:** CRITIQUE-2 C1, and §22.2's question of which way a measurement error
should fall.

**Unsettled by:** §14 and §22.2 both assume a text box has *a* container.

**Decision.** Two elements in the deck are sized by their own words and cannot
be otherwise: the provenance pill (`inline-flex`, §18.1's label, which must read
as a label rather than a full-width band) and the CTA (`inline-block`, a button
shape carrying the prospect's own radius and border weight). For both,
`measureScene` reports **the room the element has** — its parent's box less its
own gutters — not the box it happens to fill.

That is the right number for the detector: it is what a longer label, or the
same label in another brand's face, would need. It is also the number that errs
the way §22.2 wants, because the *rendered* box is never wider than it.

Both carry `data-pp-fit`, and `test/scene/geometry-browser.test.mjs` asserts the
set of elements carrying it is exactly those two. Growing it is a decision:
every entry is a container the model can only bound, and each one has to be
argued rather than tolerated.

The CTA's gutters include `var(--pp-border-width)` — the *prospect's* border
width, twice. That is the only length in the stylesheet whose value is not
knowable until a brand is in hand, so it is a named inset (`brand-border`)
resolved from the `BrandSystem` at measure time rather than from `GEOM`.
`PANEL_BORDER_PX` deliberately keeps brand border weight off panel chrome for
the reason geometry.js states; this is the one place it genuinely reaches a text
box, and the measurement now follows it there.

---

## L8-29 — A right-to-left rendition renders right to left

**From:** CRITIQUE-2 C8 — *"the ar-SA locale rendition is thrown away by the
renderer"*.

**Unsettled by:** §9.1 asks `locale-fanout` for "locale-appropriate structure,
not just translated strings" and §4's `ContentBlock` has no way to say which way
a block reads.

**What was wrong, and which rule won.** §8's "raw source is never presented as
markup by a layout" is about *captured* source — the prospect's HTML, which a
layout must not execute or trust. L7's locale renditions arrived as `raw` blocks
carrying `dir="rtl" lang="ar-SA"`, `blocks.js` flattened every one of them to
plain text under the caption "Source markup, shown as text", and the
Arabic-market rendition rendered left to right, labelled as if it were the
prospect's own page source. Two rules collided and the wrong one won: a
rendition produced from a seed recipe is not captured source, and direction is
not markup.

**Decision.** `dir` and `lang` are read wherever a block or a rendition declares
them (`src/scene/direction.js`), and emitted as HTML attributes on the element
that carries that content. Three rules:

- **The block wins over the rendition.** A rendition mixes the source's language
  with the tool's own structural labels, so no single `lang` is true of the whole
  of it — the same asymmetry L7 records as D-L7-18, read from this side.
- **Nothing is guessed.** A block that declares nothing gets no attribute, and
  the rendered markup for a deck that declares nothing is byte-identical to what
  it was. Inferring a market's reading direction from the text would be a claim
  about the client's market that §18.2 does not let this tool make.
- **A label is not prose.** `contentsIndex` and `systemMap` render a rendition's
  `label` ("ar-SA") and `renditionMeta`'s English sentence about how it was
  produced, and neither is the rendition's copy — so neither carries the
  direction. `test/scene/direction.test.mjs` pins that down by asserting no text
  from the rendition's blocks reaches either layout, so the claim is checked
  rather than asserted in a comment.

The stylesheet was made logical where it dresses *content* — `.pp-quote`'s rule,
`.pp-raw`'s rule, the table's `text-align: start` — because a `dir` attribute
every rule then overrides with a physical side is direction honoured on paper.
Scene chrome that belongs to the seller rather than the market (`.pp-side-note`'s
accent rule) stays physical, deliberately.

**§8 still holds.** A `raw` block is still flattened to text under its caption,
because that rule is about what a layout may execute. What changed is that the
direction survives the flattening, and that the caption is itself marked
`dir="ltr" lang="en"` — it is the tool's English sentence about the block, not
the block.

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
gives the run. `containerHeightPx` is the height the layout *affords* the box:
exact where the CSS constrains it (a fan card's equal share, a step's share of
the stack, a clamped run's own box), and the remaining height of its nearest
constraining ancestor where the box is auto-height. Every box additionally
carries three optional fields beyond the declared shape:

- `fontStack` — the CSS stack `style.family` heads, so L11 can resolve
  availability without re-deriving it from the brand;
- `containerId` — a stable id for the container instance, so boxes that stack
  inside one column can be summed for cumulative overflow;
- `slot` — the geometry slot's name, for reporting.

**Why.** A per-box height that pretended to be exact for an auto-height run
would be a fiction, and one that reported zero would make every column
un-checkable. Reporting the affordance flags the single run that cannot fit, and
`containerId` gives the detector everything it needs to catch the case where six
runs each fit and their sum does not. Extensions are additive, which `API.md`
explicitly permits.

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

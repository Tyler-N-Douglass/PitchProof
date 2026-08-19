# L12 Studio UI — lane decisions

Every judgment call §15, §16 and §20.10 did not settle, with its rationale, in
`DECISIONS.md` style. Nothing here overrides `PITCHPROOF-BUILD-SPEC-v1.0.md`,
`API.md`, or D1–D17.

---

## L12-1 — The studio patches the DOM rather than re-mounting it

**Unsettled by:** D4 fixes VNode as the render target and `core/vdom.js` provides
`mount()`, which clears an element and rebuilds it. §15 makes the studio a
destructive editing surface used under time pressure.

**Decision.** `src/ui/render.js` reconciles: elements with the same tag and the
same `data-st-key` are updated in place, `value`/`checked` are written as
properties and only when they differ, and an element carrying `data-st-preserve`
has its attributes patched and its children left alone.

**Why.** `mount()` throws away focus, caret position, scroll offsets and any
element another owner is holding — and the studio has such an element, the live
preview, whose subtree belongs to `RuntimeHost`. Re-mounting on every keystroke
would make typing a headline impossible and would tear down the preview's
runtime forty times a sentence. The property-not-attribute rule for `value` is
the part that matters most in practice: writing `value` when it already matches
still moves the caret to the end in some browsers, so the patcher writes it only
on a real change. Verified in Chromium: typing into the prospect field keeps
focus and the caret (`test/ui/render.test.mjs`, plus a browser walk).

---

## L12-2 — Interaction is declared, not bound

**Unsettled by:** nothing in the spec says how a VNode tree gets handlers.

**Decision.** A node declares `data-st-act="<action id>"`, optionally
`data-st-arg` and `data-st-on`; one delegated listener per event type at the root
turns that into `app.dispatch(...)`. No VNode ever carries a function.

**Why.** Three things fall out of it, and each is a spec obligation:

- `toHtml(render(state))` is a pure string, so "the same state renders identical
  HTML twice" is a real assertion rather than a shape comparison (§5);
- the whole interface can be enumerated by walking the rendered HTML for
  `data-st-act`, which is how `test/ui/keyboard.test.mjs` proves §20.10's
  "requires a mouse where a key would do" mechanically instead of from a list
  somebody maintained;
- no closure survives a render, so the patcher can reuse an element without
  worrying about a stale handler.

---

## L12-3 — The live preview mounts into its own document

**Unsettled by:** §15 asks for a "live preview at true aspect" and forbids the
artifact wearing the studio's palette; D11 makes the two variable namespaces
disjoint but says nothing about how the artifact's `html`, `body` and `:root`
rules are kept off the studio.

**Decision.** `src/ui/preview.js` creates an `<iframe>` with **no `src`**, writes
its document directly (the way `runtime/presenter.js` writes the presenter
window, D16), and mounts the real `Runtime` + `RuntimeHost` into it. The frame is
sized to the exact pixel dimensions of the chosen `BREAKPOINTS` entry and scaled
to fit. Where a host gives no usable frame — a test harness, a very old browser —
it degrades to mounting the same runtime into a plain element and says so in
`preview.degraded`.

**Why.** The artifact stylesheet contains `:root`, `html` and `body` rules. There
are two ways to keep them off the studio: rewrite the selectors, or give the
artifact its own document. Rewriting is a CSS transform that has to be right for
every rule the eight layouts will ever produce, and when it is wrong the preview
lies about what the artifact looks like. A separate document is exact, needs no
transform, and makes "true aspect" literal rather than approximate: what is on
screen is the artifact at a known width, scaled, not a guess at it. It costs
nothing offline — there is no `src` and nothing to load.

---

## L12-4 — The editable document is the proof plus its name and seed

**Unsettled by:** §15 requires "undo/redo across all model mutations"; §16 stores
a project record whose name and seed sit outside the `Proof`.

**Decision.** The command stack's state is `{id, name, seed, proof}`. Renaming a
project and changing its seed go on the undo stack alongside scene edits.

**Why.** "All model mutations" is about what a user can lose, not about which
side of a serialisation boundary a field sits on. Renaming a project the day
before a pitch and being unable to take it back is the same class of defect as
deleting a scene and being unable to take it back.

---

## L12-5 — A reducer that changes nothing returns what it was given

**Unsettled by:** `core/command.js` pushes whatever it is handed.

**Decision.** Every reducer in `src/ui/model.js` preserves object identity when
nothing changed (`mapChanged`, `withProof`), and `app.mutate` skips the command
entirely when `updater(doc) === doc`.

**Why.** Without it, "remove the last beat of a scene" — which is refused,
correctly — would still land an entry on the undo stack whose undo does nothing.
An undo stack with silent no-ops in it stops being trustworthy exactly when it
matters, and §15's whole justification for undo is destructive editing under time
pressure.

---

## L12-6 — §7's review gate is a studio blocker, not a `Finding`

**Unsettled by:** §7 requires the studio to surface low-confidence brand fields
"for review before they can be used in an emit". §4 freezes `FindingCode`, and
none of the fourteen codes covers it.

**Decision.** `src/ui/gate.js` computes a list of `Blocker`s distinct from
`Finding[]`: severity-1 findings from the last sweep, a missing or stale sweep,
an unavailable validator or emitter, an empty spine, and every unreviewed
low-confidence brand group. The emit button is closed while any blocker stands,
and the panel lists every one with a route to the section that fixes it.

Review state is stored as `BrandSystem.reviewedGroups?: string[]`, an optional
extension field, which §4 permits ("lanes may extend with optional fields only").
It travels with the project export and survives a reload, because a review that
evaporates when the tab closes is not a review.

**Why.** Inventing a fifteenth `FindingCode` would be contract drift, and
lowering the review gate into a warning would make §7's "before they can be used
in an emit" false. Keeping the two lists separate also keeps the honesty
straight: a `Finding` is what L11 measured, a `Blocker` is what the studio will
not do yet.

---

## L12-7 — Imagery is classified from no samples, and therefore held for review

**Unsettled by:** L5's `classifyImagery` takes decoded RGBA `ImageSample[]`; no
surface declared in `API.md` Part 3 turns a captured asset into one.

**Decision.** `services.imagerySamples(assets)` is the seam. It looks for a
`sampleFromPng` on L5's declared surface and, finding none, returns `[]` — so
L5's classifier says `treatment: 'unknown'` at confidence 0, and §7's review
gate holds imagery for a person to set by hand. The moment `brand/theme.js`
re-exports `sampleFromPng`, that one function starts producing samples and
nothing else changes.

**Why.** The honest alternatives were to guess a treatment (a fabrication
wearing a confidence number) or to reach into another lane's undeclared
internals for a PNG decoder (a rule-1 violation that breaks silently on a
refactor). Reporting "unknown, 0% confident" is true, is visible, and — since
L12-15 — cannot be signed off, because there is nothing there to sign off.

---

## L12-8 — The colour solve is fed stylesheet text, not page source

**Unsettled by:** §7 collects colour "from computed styles where available,
otherwise from the raw CSS and from a quantization pass over the hero imagery
and the logo". The studio has no rendered page, so no computed styles.

**Decision.** `services.stylesheetSources` assembles real stylesheet text, in
cascade order: every `text/css` asset the capture carried, then every `<style>`
element, then every `style="…"` attribute wrapped in a synthetic rule.
`services.logoColorSources` adds the fill, stroke and stop colours of any inline
SVG mark, which L4 accepts directly as CSS colour strings — that is the half of
§7's "quantization pass over the hero imagery and the logo" that needs no image
decoder. An empty palette at zero confidence remains a legal outcome, and the
Brand panel offers manual entry of every §4 role.

**Why.** This started as `css: [capture.html]`, which works only by accident: a
`<style>` body happens to be inside the page text. It finds nothing at all when
the colour lives in a linked stylesheet — which is every enterprise site, and
was the corpus. CRITIQUE-1 F1/F3 found it as "the studio extracted ZERO colour
roles". The root cause was L3 fetching only the document, but the studio was
holding it wrong too: given the stylesheet, it would still have thrown most of
it away. `test/ui/critique-1.test.mjs` asserts a linked stylesheet is read and
that page source is not passed off as CSS.

---

## L12-9 — Every cross-lane call goes through one adapter, and an unwired lane says so

**Unsettled by:** `API.md` declares nine lane surfaces; nothing says how a lane
that has not landed should behave in the interface.

**Decision.** `src/ui/services.js` is the only file in `src/ui/**` that imports
another lane. Every method is total: it does the lane's work or returns an `err`
naming the module path. `services.missing()` drives a status-bar line and a
Settings table, so the user is told which lanes this build does not have. An
unavailable validator is itself an emit blocker.

**Why.** Nine lanes were written in parallel, so "the wiring is one file" was a
practical necessity during the build and remains the right shape afterwards: the
integrator has one seam to check. Making the adapter injectable is what let every
panel be tested before six of the nine lanes existed. Failing loudly is the
§18.4 discipline applied inward — a panel that silently does nothing is a
promise, and this product does not make promises it cannot show.

---

## L12-10 — A render that provokes a render is coalesced, not nested

**Unsettled by:** nothing; discovered by driving the studio in Chromium.

**Decision.** `StudioApp.render` holds a re-entrancy flag. A render requested
while one is in flight sets `renderQueued`; the outer call drains it, at most
three passes.

**Why.** Painting the canvas can move the preview's runtime, the runtime
announces the move, and the announcement asks for another render. Left alone that
nests renders until the stack gives out — which is exactly what happened, and it
took down the rehearsal sweep with it. The cap is deliberate: a render that keeps
asking for another render is a bug, and an unbounded drain would hide it rather
than show it.

---

## L12-11 — Drafts are outside the command stack

**Unsettled by:** §15 requires undo across model mutations.

**Decision.** Text that is not yet a model change — a URL about to be fetched, a
paste about to become a rendition, an alias about to be added, the command
palette's query — lives in `app.ui.drafts` and never touches the stack.

**Why.** §15's undo is about the model. Undoing a half-typed URL is noise that
would bury the edit the user actually wants back.

---

## L12-12 — Beats can be planned from what the layout actually renders

**Unsettled by:** §15 asks the scene panel to "edit the beat plan (add, remove,
reorder beats; choose what each reveals)". It does not say the plan has to be
built one checkbox at a time.

**Decision.** `beat.autoPlan` builds one beat per revealable element, up to eight,
folding the remainder into the last beat. It preserves each existing beat's
presenter note and pacing hint.

**Why.** The revealable set comes from the real rendered tree, so the plan is
correct by construction and takes a second instead of a minute. Preserving the
notes is the §20.10 "loses work" rule applied to the one field the tool cannot
regenerate.

---

## L12-13 — The undo history is the auto-fix log

**Unsettled by:** §14 requires every auto-fix to be "logged and undoable" — two
things that can disagree.

**Decision.** An auto-fix is an ordinary command carrying
`meta: {autoFix: true, code, label}`. The Rehearse panel's "auto-fixes applied"
list is the undo history filtered to those entries, and "undo every auto-fix"
walks the stack with `undoUntil`.

**Why.** One structure cannot disagree with itself. Nothing can be recorded in
the log that cannot be taken back, and nothing can be taken back without leaving
the log.

---

## L12-14 — The seed recipe library is runnable from the studio, not only pasteable against

**Unsettled by:** §9 says "Default adapter is manual" and that the paste path
"must be excellent, not a fallback", and separately calls the eight seed recipes
"the reframe payload — build all of them". It does not say the studio must be
able to *run* one.

**Decision.** `recipe.run` runs one seed recipe against the selected specimen;
`recipe.runAll` runs every recipe that accepts it. Both go through
`services.renderRecipe` / `renderAllRecipes`, both are ordinary undoable
mutations, and everything they produce is stamped `illustrative` by L7. The
Recipes panel shows a Run control per recipe, greys out the ones whose
`inputKinds` do not match the specimen, and says why.

**Why.** CRITIQUE-1 F14: L7 built all eight templates, `renderAll` produced 34
renditions from one call, and there was no route to any of it from the shipped
studio. "Default adapter is manual" is about *provenance* — the tool must not
imply generated content is client-approved — not about the studio being unable
to lay out the argument. A template rendition and a pasted one are both
illustrative until a person promotes them, so the honesty law is untouched, and
a seller who wants the shape of the locale fan-out before they have nine real
translations can now have it. Verified in the browser: 32 renditions from 7
recipes on a corpus product page.

---

## L12-15 — A brand group with nothing in it cannot be reviewed

**Unsettled by:** §7 requires the studio to surface low-confidence fields "for
review before they can be used in an emit". It does not say what happens when
the field set is empty.

**Decision.** `brandGroupEvidence(brand, group)` decides whether there is
anything to review: content for the list-shaped groups, and content *or* a
recorded manual override for `shape` and `imagery`. `setBrandReviewed` refuses a
group with no evidence and returns the document unchanged; the gate reports it
as `BRAND_EMPTY` rather than `BRAND_UNREVIEWED`; the checkbox is disabled with
the reason beside it; and the bulk control cannot reach it at all.
`replaceBrand` prunes reviews that no longer cover anything, so a re-extraction
that found less cannot inherit the sign-off the last one earned.

**Why.** CRITIQUE-1 F15: five groups at 0% confidence containing nothing, marked
reviewed by one button, clearing five of seven emit blockers. Reviewing an empty
set is not a review — there is no claim there to accept — and a gate that can be
cleared by pressing a button on nothing is not a gate. The distinction the
studio now draws is the useful one: *unreviewed* is a thing to look at, *empty*
is a thing to go and get.

---

## L12-16 — `API.md` Part 3 is checked from the consuming side too

**Unsettled by:** `test/core/api-conformance.test.mjs` asserts each lane
publishes what it declared. Nothing asserted anyone consumed it.

**Decision.** `test/ui/lane-conformance.test.mjs` parses Part 3 and the
adapter's own import statements, and requires every declared surface of every
lane the studio imports to be either called in `services.js` or explained in
`LANE_SURFACE_NOTES` with a reason of real length. A stale note — one that
explains away a call that exists — fails too.

**Why.** This is the critic's sharpest point about F14, and it is about process
rather than code: a dependency stated in a document and tested from one end is
not a dependency, it is a note. Six surfaces turned out to be worth wiring once
the question was asked out loud — `fetchStrategies` (§6's routes, quoted to the
user when a fetch returns only the document), `returnTargetFor` (the scene a
branch actually lands on, §22.4), `RULES` (what a sweep checks, before one has
run), `checkContrast` (§22.1, live beside the hex being typed), `measureScene` +
`detectOverflow` (§22.2, live at all three breakpoints beside the headline being
typed), and `scanForNetworkReferences` + `assertProvenance` (§18.4, re-run over
the emitted bytes for the moment somebody in the room asks how you know). The
rest are declined in writing, mostly because they are reached through a
one-call entry point the lane itself provides.

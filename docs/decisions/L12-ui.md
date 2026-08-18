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

**Unsettled by:** L5's `classifyImagery` takes decoded RGBA `ImageSample[]`;
`API.md` gives the studio no declared surface that decodes a page's images into
RGBA.

**Decision.** `services.buildBrand` passes `images: []`. L5's classifier returns
`treatment: 'unknown'` at confidence 0, which routes imagery straight into §7's
review gate, where a person sets it by hand.

**Why.** The honest alternatives were to guess a treatment (a fabrication wearing
a confidence number) or to reach into another lane's undeclared internals for a
PNG decoder (a rule-1 violation that would silently break when that lane
refactors). Reporting "unknown, 0% confident" is true, is visible, and cannot be
used in an emit until somebody has looked at it. **Integrator note:** if L5 or L6
later declares a sample-building surface, wiring it is one line in
`services.js`'s `brandParts`.

---

## L12-8 — Colour is solved from CSS, and an empty palette is a legal outcome

**Unsettled by:** §7 collects colour "from computed styles where available,
otherwise from the raw CSS and from a quantization pass over the hero imagery and
the logo". A studio with no rendered page has no computed styles and (per L12-7)
no decoded pixels.

**Decision.** `services.buildBrand` calls L4's `extractPalette({css})`. When no
colour can be collected it returns an empty palette at zero confidence rather
than throwing, and the Brand panel offers manual entry of every §4 role.

**Why.** §6 requires ingest to "degrade gracefully and never dead-end", and the
brand step is the first place that promise is tested. A prospect whose CSS is
behind a bundler still has a brand; the studio's answer is a form, not an error.

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

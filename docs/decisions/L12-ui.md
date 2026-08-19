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

---

## L12-17 — An empty collection is never reported as a missing capability

**Unsettled by:** §18 makes honesty an enforced code path in the *artifact*.
Nothing says the same rule binds the studio's own copy, and §15 does not say
what an empty panel should read like.

**Decision.** Every empty state, hint, placeholder and disabled-control reason
in `src/ui/**` states the true cause. Three cases that were being collapsed are
now kept apart wherever they can occur:

| cause | what it is | who fixes it |
|---|---|---|
| the lane did not load | a build defect | the integrator |
| the collection is empty | a new project | the seller, by adding one |
| the collection was measured and came out poor | a result | the seller, by reviewing it |

`test/ui/empty-state-honesty.test.mjs` holds the line: it renders every panel,
the inspector and the shell in four states over the **real** lane adapter and
fails on any painted string matching a phrase that asserts absence — `not
wired`, `into this build`, `not implemented`, `coming soon`, `TODO`, `stub` and
sixteen more. It asserts against the VNode tree, collecting text nodes, raw
markup and the four attributes that paint (`title`, `placeholder`, `aria-label`,
`alt`), so a phrase in a comment or in a string no panel returns does not trip
it and a phrase that reaches the screen cannot hide. It first asserts
`services.missing()` is empty, so a lane that genuinely goes missing fails with
its own name rather than making a true sentence look like a lie.

**Why.** §18 is a section about a tool not overstating or misstating what it
knows, and the studio misstating its own capability is the worst version of it —
it is aimed at the person deciding whether to trust the product. CRITIQUE-1 F22
is the whole argument in one string: with zero branches the jump-index hint read
"The branch lane builds this index; it is **not wired into this build**". The
lane was wired. There were no branches. A seller who reads that reasonably
concludes the jump index does not work and stops using the interaction §11 names
as the product's headline. The phrase-scanning test exists because one such
string is a category rather than an incident, and the positive assertions beside
it exist because a phrase test on its own is passed by deleting the sentence,
which trades a false empty state for a blank one.

---

## L12-18 — 0% confidence on an untouched brand reads as unmeasured, not as a failed extraction

**Unsettled by:** §7 requires low-confidence fields to be held for review. It
does not distinguish "extraction ran and could not tell" from "nothing has been
extracted", and `model.emptyBrand` gives a new project four colour roles and one
face so the panel has something to render.

**Decision.** `brandGroupIsStarterDefault(brand, group)` compares a group against
`emptyBrand()` and against `manualOverrides`. A group that is still exactly what
a new project ships with raises `BRAND_DEFAULTS` rather than `BRAND_UNREVIEWED`,
with a message that says nothing has been extracted and nothing entered; the
Brand panel lists those groups separately from genuinely low-confidence ones, and
`brandIsUntouched` puts one sentence above the five 0% bars saying that 0% here
means *not measured*.

The group stays reviewable. The checkbox's hint says what ticking it accepts:
"These are still the studio's starting values, so ticking this accepts them as
the brand the artifact will wear."

**Why.** Five confidence bars at 0% look like a broken extractor, and the blocker
made it worse by saying the roles "came out 0% confident" and asking for them to
be checked "against the source" — a measurement that never ran, against a source
that does not exist (`brand.sourceUrl` is `null`). That is the F22 defect in a
different panel: an empty collection described as a broken system, and a
disabled-control reason naming the wrong cause.

Keeping the group **reviewable** is the judgement call, and it is where this
parts company with L12-15. F15's rule was that reviewing an empty set is not a
review because there is no claim there to accept. Here there *is* a claim on
screen — four hex values and a font stack — and accepting it is a real act with
real consequences, so a person is entitled to make it. What they were not being
told is *what* they were accepting. They are now. The stronger option — refusing
sign-off until something has been extracted or entered — is defensible on §18
grounds, since an artifact wearing PitchProof's navy while claiming to be the
prospect's brand is exactly what §15 forbids; it is recorded in
`docs/disputes/L12-ui.md` as D-L12-7 rather than taken unilaterally, because it
closes the emit on a new project and that is the integrator's call.

---

## L12-19 — Two descriptions of one guarantee is how a guarantee drifts

**Unsettled by:** nothing; found by L7 auditing F23 and handed to this lane.

**Decision.** `services.promotionRecord`'s doc comment described L7's token as
one that "cannot be hand-forged". It can: `promotionSignature` is
`shortHash({v, by, at, of, from}, 16)`, unkeyed, and `formatPromotionRecord` is
exported. The comment now says what the digest actually is — tamper-evidence
against corruption and partial edits, not authenticity — and why no better thing
is available (§1.1 forbids a backend and accounts, so any key would ship inside
the artifact the forger already holds), and notes that the digest is not the
weakest link anyway, since `provenance: 'client-supplied'` suppresses the
illustrative label in one word with no record at all.

The sentence a *person* sees comes from L7's exported `PROMOTION_RECORD_LIMIT`,
rendered verbatim beneath the "verifies against itself" badge in the Recipes
panel. The studio does not paraphrase it.

**Why.** "Verifies against itself" is accurate and, alone, easy to read as "we
know who did this" — so the limit belongs next to the outcome it qualifies. And
the reason to take L7's string rather than write one is in the finding itself:
two descriptions of one guarantee is precisely how this adapter's comment came
to claim more than the digest delivers and stay that way for a pass.
`PROMOTION_RECORD_LIMIT` is a lane extension rather than an `API.md` Part 3
surface, which is recorded as D-L12-8.

---

## L12-20 — An unread measurement is not a refused measurement

**Unsettled by:** §16 requires a storage-pressure warning at 80% of the estimated
quota. It does not say what to show before the estimate has been read.

**Decision.** `app.ui.pressure` carries `measured: boolean`, set only by a real
`store.pressure()` reading. Before the first reading the Project panel and the
status bar say "reading the quota"; after one that returned no quota they say
"this browser would not report a quota" / "no quota reported".

**Why.** The old string asserted a fact about the browser — that it "will not
report a quota" — on first paint, before the browser had been asked. It happens
to be a small lie, and it is the same lie as F22: a state the tool has not
reached yet, reported as a capability the tool does not have.

---

## L12-21 — One compile of the brand, read from both ends

**Names:** CRITIQUE-2 C7.

**Unsettled by:** §15 asks for "live preview at true aspect" and §13 for an
emitter that inlines the stylesheet. Nothing says the two must be the *same*
stylesheet, because it did not occur to anyone that they could differ.

**Decision.** `services.artifactThemeCss(brand)` is the only way anything in
`src/ui/**` obtains the artifact's stylesheet. `preview.js` installs its return
value into the frame; `services.emit` passes the same call's result to L10 as
`deps.themeCss`. `compileTheme` survives beside it for the inspector, which
counts the custom properties rather than rendering them.

**Why.** The emit passed no `themeCss` at all, so every artifact ever emitted by
this studio fell through to `compileFallbackTheme` — the path L10 documents as
the one for a build where L5 has not landed. L5 has landed since the first pass.
Nineteen of twenty-three properties agreed, which is exactly what made it
survive: the artifact looked right, and the stage padding, the transition
duration and the shadow — the three the preview is *for* — were not the ones the
seller shipped.

The fix is one argument. What is worth keeping is the shape of the test:
`test/ui/critique-2.test.mjs` asserts the emitted document contains the preview's
stylesheet **byte for byte**, and separately that every property the two
compilers disagree about arrives the preview's way. A test that checked the
artifact merely *had* a theme passed for a whole pass while this was broken.

---

## L12-22 — The licence is the file

**Names:** CRITIQUE-2 C3.

**Unsettled by:** §7 says `embeddable` is false "unless the user explicitly
supplies a font file they assert they have rights to" and §13 inlines
"fonts (only user-supplied, license-asserted)". Neither says what the control
looks like, and the previous pass built the assertion without the supply.

**Decision.** Four changes, and they only work together:

1. `brand.attachFont` — a per-face `<input type=file>` accepting `.woff2`,
   `.woff`, `.ttf`, `.otf`. It routes through L5's `attachUserFont` with the
   file's bytes, a `data:` URI, the face's observed weights, and a rights
   assertion naming the operator, and stores the face L5 returns.
2. `services.emit` passes `fonts: artifactFonts(proof.brand)`, so the rules L10
   was already able to write reach the artifact.
3. `brand.setFaceEmbeddable` **is deleted**. §7 permits one route to `true` and
   L5 already enforces that; a second control that set the flag directly could
   only ever be a claim with no fact under it. Withdrawal is
   `brand.detachFont`, which removes the file, the assertion and the flag in one
   mutation — withdrawing a claim *does* change what ships, so it is allowed.
4. `loadRecord` clears an `embeddable` claim carrying no file and says so.
   Nothing in this build can create one; an older project or an imported
   `.pitchproof.json` can, and L11 reads the flag as "this family is available",
   so an unfounded claim silences FONT_UNAVAILABLE for a face the client's
   machine will substitute anyway.

**Why.** The measured behaviour of the old checkbox: two FONT_UNAVAILABLE
warnings cleared, emit opened, no embedded face in the artifact, the prospect's
family still at the head of the CSS stack — so the client rendered Arial while
the studio said the face was embedded. That is §18 turned exactly inside out,
and the specific sentence FONT_UNAVAILABLE prints ("supply a licensed font file
to embed") named a remedy the product did not offer.

**The judgment call is (3).** A gentler option existed: keep the checkbox and
disable it until a file is attached. It was rejected because a disabled control
still teaches that the flag is the thing being set, and the flag is not the
thing — the file is. The panel now shows either the attach control, or the
file's record with its size, who asserted the licence and when.

**What is deliberately not done.** The studio does not parse the font file: it
does not verify the family inside it, its weights, or that it is a font at all
beyond the extension. Nothing in the product reads a font — §13 inlines it and
the client's browser is what parses it — and a parser here would be a second,
worse copy of the browser's. The refusal that *is* enforced is the MIME: a file
the studio cannot name is refused rather than embedded as
`application/octet-stream`, because a src the browser will not parse is a font
that silently does not load, which is the failure this whole finding is about.

---

## L12-23 — A save says which project is in hand

**Names:** CRITIQUE-2 C6.

**Unsettled by:** §16 requires autosave and a migration path. It does not say
what the studio opens on start.

**Decision.** `saveNow` writes `studio.lastProject` on every successful save.
`loadRecord` still writes it too, so an open and an import are unchanged.

**Why.** The setting was written only by `loadRecord`, which runs on open and on
import — never on create. So the studio restored every project except the one
being built right now, and only on the reload nobody planned. Nothing was lost;
the record was in IndexedDB and one more open restored it, which is precisely why
it survived a pass of testing.

Choosing the *save* rather than the create is the judgment. A create writes
nothing durable until the first save, so binding the setting to `project.new`
would point the next start at a record that may not exist. A save is the
strongest statement the studio can make about which project is in hand, and it
is already the one choke point every route runs through: new, duplicate, import,
autosave and `Ctrl+S` all end in `saveNow`.

---

## L12-24 — A sweep that walked nothing is vacuous, not clean

**Names:** CRITIQUE-2 C11.

**Unsettled by:** §14 makes rehearsal "the last pass before you walk in" and
requires severity-1 findings to block the emit. It says nothing about what the
panel should say when the sweep had nothing to walk.

**Decision.** Three strings, one count, one gate:

- `model.deckPositions(proof)` is computed once and read by both the Rehearse
  panel and the sweep action's notification. Zero positions makes the banner a
  warning that names what was not measured (overflow and contrast, at all three
  breakpoints) and what to do about it.
- The blocking-findings empty state no longer asserts anything about the gate on
  its own. It asks `emitBlockers` and either says "Nothing blocks the emit." —
  when nothing does — or names the blocker still standing, in the gate's words.
- The sweep's own notification stops calling a walk of nothing "clean", and
  stops reporting the number of *findings* as the number of *checks*; the rule
  count is what ran.

**Why.** The panel printed "Sweep clean across 2 checks", "Nothing blocks the
emit" and "Scenes walked 0" together, above a status bar reading "This proof has
no spine". Each sentence was derived from something the studio knew; two of them
were false where they stood. This is the same category as the last pass's F22 —
a true-sounding sentence about a state it does not describe — so the guard has
the same shape: the false strings are banned in
`test/ui/empty-state-honesty.test.mjs` **and** the true ones are pinned, in that
file and in `test/ui/critique-2.test.mjs`, so the finding cannot be closed by
deleting the reassurance a rehearsal panel exists to give.

---

## L12-25 — Two test-scaffold repairs, recorded because they touched shared files

**Names:** CRITIQUE-2 C3 and C15.

**Decision and why.**

`test/fixtures/ui/studio-fixture.mjs` gains `artifactThemeCss` and
`attachUserFont` on the fake adapter. The fake refuses on the same two
conditions L5 does — no file, or no rights assertion — so a caller that skips
either fails in the fixture rather than only in the shipped studio. The file
lives outside `test/ui/**` by path but is imported by nothing else in the
repository; it is this lane's scaffolding.

`test/ui/storage-pressure.test.mjs`'s `RiggedBackend` extended `MemoryBackend`
with `super(estimate.quota)`, passing a *ratio numerator* (100) as a byte
capacity. That was harmless until L1 landed C15's fix and `MemoryBackend` began
refusing writes past the quota it reports — at which point four tests about the
pressure *reading* started failing on the enforcement path instead. The rig now
reports the ratio through `estimate()` and enforces a real capacity, which
separates the two axes it had been conflating. No assertion was weakened; the
refusal path is still tested, deliberately, through `failWith`.


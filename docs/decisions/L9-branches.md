# L9 Branches — decisions

Judgment calls the spec and `API.md` did not settle, in `DECISIONS.md` style.
Nothing here overrides `PITCHPROOF-BUILD-SPEC-v1.0.md`; where a decision touches
another lane it is repeated in `docs/disputes/L9-branches.md`.

---

## L9-1 — The jump index is scored in tiers, not by a similarity number

**Unsettled by:** §11 requires fuzzy search over objection text and aliases and
states one acceptance case ("three characters of 'approvals' … under a second"),
but names no ranking model.

**Decision.** Every candidate is scored by the best of seven strategies, each
with a base far enough from its neighbours that no bonus can cross a tier:
exact 1000, whole-term prefix 900, word prefix 800, substring 700, acronym 640,
every-query-word-matched 600, subsequence 420, bounded typo 500 → 300. Within a
tier, coverage (how much of the term the query accounts for) and position (how
early the matching word sits) break the score. The field weight multiplies the
result: objection 1.0, alias 0.94. Ties break by deck order, then by branch id.

**Why.** A single blended similarity score cannot express "a prefix always beats
a typo", which is the property a presenter's muscle memory depends on: the same
three letters must produce the same first row every time, in every deck, or the
key sequence stops being reflexive and starts being a decision. Tiers make that
orderable and testable rather than emergent — `test/branch/jump-search.test.mjs`
asserts the ordering law directly, not just the winner. The alias weight is
deliberately close to 1: an alias is a real phrasing the seller wired, so it
should lose to the client's own words only at equal quality.

---

## L9-2 — Branch ids are not search terms

**Unsettled by:** §11 says the index is built "over objection text and aliases";
it does not say whether anything else may be indexed.

**Decision.** Only `Branch.objection` and `Branch.aliases` produce terms. A
branch id (`bn_approvals`) matches nothing.

**Why.** Two reasons, and the second is structural. A branch findable only by
its minted id is not findable in a room — nobody types `bn_` under pressure. And
§11's coverage rule defines `BRANCH_UNREACHABLE` as "no anchor **and** no
jump-index entry": if ids were indexed, every branch would always have an entry
and that finding could never be raised, which would quietly delete a §14 check
and hand the §20.6 critic a pass it did not earn.

---

## L9-3 — An unanchored branch has no *declared* return, and is reported

**Unsettled by:** §11 requires `BRANCH_NO_RETURN` "for any branch whose last
scene lacks a resolved return target", but a branch reachable only from the jump
index still returns correctly at runtime — the stack remembers where the jump
came from.

**Decision.** `returnTargetFor` resolves the **authored** return: for
`returnPolicy: 'anchor'` the scene that offers the branch; for `nextSpineScene`
the spine scene after the anchor, walking the anchor chain up to the spine and
clamping at the end of it. A branch with no anchor at all resolves to `null`
under either policy and appears in `noReturn`, with `reasons: ['unanchored']`.

**Why.** The runtime's dynamic recovery is not a substitute for an authored
exit. A jump-only branch behaves correctly for the presenter who jumped into it
and has nowhere declared to go for the rehearsal sweep, the branch map, or the
§14 auto-fix that offers to "generate a missing return target" — all three need
a static answer. Reporting it keeps `returnTargetFor` and `branchCoverage`
consistent (`noReturn` is exactly the set with a null target), and the `reasons`
field lets L11 grade it: **`unanchored` deserves severity 2, not 1** — the proof
is presentable, it is just under-declared — while `no-scenes` and
`anchor-chain-never-reaches-spine` are structural faults. L9 does not set
severities; §17 gives that to L11.

---

## L9-4 — `matched` is an array of ranges in source coordinates

**Unsettled by:** `API.md` fixes the key name and nothing about its shape.

**Decision.** `matched` is `{start, end, field, text}[]`, where the offsets index
the **original** string (the one the presenter reads), not the folded one used
for matching. The result also carries `matchedField`, `matchedText` and `kind`.
`highlightRuns(text, ranges)` turns a text and its ranges into
`{text, hit}[]` for a renderer that cannot hand out DOM.

**Why.** An array maps directly onto a renderer. Source coordinates are the only
ones that can be highlighted: folding strips diacritics and can change length,
so a folded offset lands mid-word on "Créative". The fold keeps an index map for
exactly this, and a test asserts the highlight lands on the accented characters.

---

## L9-5 — The jump index's live state is an object, not the DOM

**Unsettled by:** §11 requires a search field navigable by arrow keys; `API.md`
gives overlays a pure `render(ctx) => VNode` and no input path (dispute §2).

**Decision.** `JumpController` holds `{query, selection}` and is exposed at
`runtime.branchJump`. The overlay renders it. Keys and characters reach it
through `installBranchInputBridge(runtime, {document})` — an optional, additive
export and the only file in `src/branch/**` that knows a document exists.

**Why.** The host repaints by replacing the overlay subtree, so state kept in
the input element would be destroyed on every keystroke. State in an object
survives the repaint, is drivable from `node --test` with no browser, and keeps
all three renderers pure — which is what lets the emitter serialize them and the
rehearsal sweep walk them. The bridge is separable so that a proof opened
without it still *shows* the jump index; only typing is lost.

---

## L9-6 — Opening `/` lists everything; closing it forgets everything

**Unsettled by:** §11 does not say what an empty query shows or whether the
query persists.

**Decision.** An empty query returns every branch in deck order at score 0.
Closing the overlay resets query and selection.

**Why.** The empty state is the branch inventory: opening `/` and seeing the six
objections you wired is how a presenter remembers what they have. And a stale
query is worse than no query — the last objection belonged to the last moment,
and reopening onto it means reading and clearing a field instead of typing.

---

## L9-7 — Candidates come from a posting index, with a provably safe gram threshold

**Unsettled by:** §11 says the search must be instant; nothing specifies how.

**Decision.** `buildJumpIndex` precomputes postings: token prefixes to depth 5
(`p:`), character trigrams (`g:`) and acronym prefixes (`a:`). A query scores
only the entries those postings name. Prefix and acronym postings are always
taken; trigram postings require **two** shared grams once a query carries ten or
more grams, and one below that.

**Why.** Scanning every branch cost 0.52 ms per query at 200 branches; postings
cut it to 0.16 ms mean, and 0.008 ms on a realistic six-branch deck. The
threshold is set by the typo budget rather than by taste: the worst edit this
file tolerates is two transpositions, each of which can destroy four trigrams,
so a ten-gram query cannot fall below two shared grams and no reachable match
can be filtered out. Short queries — where typo tolerance actually earns its
keep — keep full recall. The one thing the filter does drop is a *subsequence*
hit sharing no trigram with the query: the weakest signal the scorer has, and
one whose absence reads as "no match" rather than "wrong match". A test sweeps
every prefix of every objection and alias in a 60-branch index and asserts the
filter never hides a hit.

---

## L9-8 — Typo tolerance starts at four characters, and counts a transposition as one edit

**Unsettled by:** §11 says the search is fuzzy; it sets no distance.

**Decision.** Edit budget by query length: 0 below four characters, 1 below
seven, 2 above. Distance is Damerau–Levenshtein (optimal string alignment), so a
transposition costs one edit, and it is measured against the best **prefix** of
each word so a query can be the front of a longer word.

**Why.** At three characters every objection in a deck is within one edit of
every other, so a typo budget there produces noise exactly where §11's
acceptance case demands precision — `app` must return the approvals branch and
nothing else. Transposition is the typo people make while talking ("sacle" for
"scale"); scoring it as two edits fails the search at the moment it is needed.
Prefix distance rather than whole-string distance is what makes "aprovals" find
"approvals process would never allow this" at all.

---

## L9-9 — The branch map is designed around what has *not* been shown

**Unsettled by:** §11 requires the map to show "where they are, what's been
shown, and what's still available" but not what to emphasise.

**Decision.** Shown branches recede (reduced opacity, neutral rule); unshown
branches keep the accent. The summary states the reserve in words —
"1 of 6 branches shown · 5 still in reserve". Branches with no anchor are
listed in their own section, and the panel states where a return would land
*from the live stack*, not from the declared policy.

**Why.** §11's own sentence says why: "knowing what you haven't shown yet is the
difference between closing cleanly and rambling". A map that highlights what is
already spent tells the presenter nothing they can act on. The live return line
uses `liveReturnTarget`, which mirrors the reducer including the
`nextSpineScene` full unwind — a presenter three levels deep needs to know where
the next key actually puts them, not what the author intended in the abstract.

---

## L9-10 — The contents index is the spine, and only the spine

**Unsettled by:** §2 says Review mode "adds a contents index"; §4 has a
`contentsIndex` layout; neither says what it contains.

**Decision.** The `contents` overlay lists spine scenes only — numbered, titled,
with their step count, marked for current and already-seen, each jumpable. No
presenter notes, no branch inventory. The overlay is registered in both modes
(`c` opens it) but its footer speaks the mode's language.

**Why.** Review mode is a document someone reads alone after the meeting. The
branches are answers to objections nobody raised in that reading; listing them
implies the reader is missing a performance. The spine is the argument, and the
argument is what a recipient navigates.

---

## L9-11 — Walks are seeded, replayable and stoppable

**Unsettled by:** §17.8 requires seeded random walks; `API.md` declares
`randomWalk(deck, {seed, steps}): NavState[]` and nothing about the mix.

**Decision.** `randomWalk` returns the states as declared. `randomWalkTrace`
(additive) also returns the actions, the max depth, and what was visited, so a
failure is replayable from the seed alone. The action mix is weighted towards
forward motion (38% next beat) with 21% jumps and 11% returns; `anchoredOnly`
restricts jumps to what the current scene offers, which is the mode with a
provable depth bound; `haltOn` stops a walk at the first state a caller rejects.
Every draw comes from the `branch/walk/*` substream of `core/prng.js`.

**Why.** A uniform action mix spends the walk thrashing the stack and never
tests a long forward run through a branch, which is where the automatic exit
(D15) lives. Weighting it like a presentation finds the bugs a presentation
finds — which is how this lane found the `exitedFrom` defect. `anchoredOnly`
exists because "the stack never nests deeper than the deck allows" is only a
meaningful assertion when the walk cannot reach a branch the scene does not
offer; with the jump index in play, depth is bounded by the number of jumps, not
by the graph. `haltOn` exists because it kept the property test at full strength
while the L2 `exitedFrom` defect was open (`docs/disputes/L9-branches.md` §1,
now closed): the walk stopped at the documented transition instead of the corpus
being weakened around it. It stays — rehearsal wants to stop at the first
anomaly rather than walk on through the wreckage, and the next thing that needs
fencing should not have to reinvent it — and it stays tested, so it still works
when that happens.

---

## L9-12 — Overlay styling lives in `src/branch/branch.css` and extends L2's shell

**Unsettled by:** `API.md` names the classes the runtime owns and says
stylesheets under `src/runtime/` and `src/scene/` are bundled; L9 owns overlay
content but is not in that list.

**Decision.** The three overlays reuse `pp-overlay`, `pp-overlay-layer`,
`pp-overlay-title` and `pp-overlay-foot` as declared, and add only new
`pp-jump-*`, `pp-map-*` and `pp-contents-*` classes in `src/branch/branch.css`,
using `--pp-*` variables exclusively. `scripts/build.mjs` picks the file up
(`cssFiles(join(SRC, 'branch'))`); the JS side of the same wiring is still open
and is recorded in `docs/disputes/L9-branches.md` §5.

**Why.** Redefining a runtime class from a lane stylesheet makes the artifact's
appearance depend on concatenation order, which is a bug that only shows up in
the emitted file. Keeping the overlays functional without their stylesheet is
deliberate for the same reason: the panels are legible and operable from L2's
shell alone, so a missed build line degrades the look, never the pitch.

# DECISIONS — L7 Recipes, adapters and provenance

Every judgment call the spec did not settle for `src/recipe/**`, with its
rationale, per §23. Same form as the root `DECISIONS.md`. Nothing here overrides
`PITCHPROOF-BUILD-SPEC-v1.0.md` or `API.md`; contract objections live in
`docs/disputes/L7-recipes.md` and are built against as written.

**D-L7-2 and D-L7-3 are binding on L10 and L11** — they define the formats those
lanes parse out of `Rendition.notes`.

---

## D-L7-1 — A rendition's id is derived from its content, excluding provenance and notes

**Unsettled by:** §5 requires every id to come from a seeded PRNG or a content
hash. It does not say which, for a rendition, nor what the hash covers.

**Decision.** `renditionId({specimenId, recipeId, label, blocks, media, producedBy})`
via `contentId('rendition', …)`. `provenance` and `notes` are deliberately **not**
in the payload.

**Why.** Two reasons, in order of importance.

First, promotion must not change the id. `Scene.renditionIds` holds references;
if promoting a rendition to `'verified-by-user'` changed its id, every scene that
showed it would silently lose it the moment a user verified their own content —
a defect that appears only in the good case, which is the worst kind. The same
argument applies to editing a note.

Second, an id that is a pure function of content makes two studios that captured
the same page and ran the same recipe produce the same ids, which is what §17.6's
byte-identical re-emit rests on. No `IdMinter` is needed anywhere in L7: there is
no positional identity in a rendition, only content.

The cost is that editing a rendition's blocks changes its id. That is correct:
edited blocks are a different rendition, and the studio's command stack (L1
`CommandStack`) is where an edit's identity continuity belongs, not here.

---

## D-L7-2 — The promotion record format (binding on L10 and L11)

**Unsettled by:** §9 says `'verified-by-user'` requires an explicit user
promotion "that records who promoted it and when". `Rendition` (§4) has no field
for it — see dispute DL7-1 — so the record goes in `notes`. Nothing specifies its
shape, and three lanes have to agree on one.

**Decision.** Exactly one line, appended after any human prose, never wrapped:

```
[[pp-promotion:1;by=<base64url>;at=<iso8601>;of=<renditionId>;from=<provenance>;sig=<16 hex>]]
```

| field | meaning |
|---|---|
| `1` after the colon | record format version; bump only by agreement across L7, L10, L11 |
| `by` | unpadded base64url of the UTF-8 promoter identity — any character is then safe inside the delimiters |
| `at` | ISO-8601 instant from the caller's injected clock: `YYYY-MM-DDTHH:MM:SS[.mmm](Z|±HH:MM)` |
| `of` | the id of the rendition the record was written for |
| `from` | the `Provenance` the rendition held immediately before promotion |
| `sig` | `shortHash({v, by, at, of, from}, 16)` — the *encoded* `by`, not the decoded one |

The matching expression, exported as `PROMOTION_RECORD_RE`:

```js
/\[\[pp-promotion:(\d+);by=([A-Za-z0-9_-]*);at=([0-9T:.+\-Z]+);of=([A-Za-z0-9_-]+);from=([a-z-]+);sig=([0-9a-f]{16})\]\]/g
```

A record is **valid** when all four hold: the version is 1; `sig` recomputes;
`at` passes a calendar check (`isIsoInstant` — `2026-02-29` is rejected); and
`of` equals the rendition's own `id`. `readPromotionRecords(rendition)` returns
every valid record oldest first, `readPromotionRecord` returns the last, and
`hasPromotionRecord` is `readPromotionRecord !== null`.

Promotion appends, so re-promotion leaves a chain and each record's `from`
records what it superseded. `verifyProvenance(rendition)` returns one string per
problem and `[]` when clean — including the three L10 cares about: a
`'verified-by-user'` with no valid record (forged), a record whose `of` names a
different rendition (copied), and a record whose signature fails (hand-edited).

**Why.** The delimiters are chosen so a record cannot be produced by ordinary
prose and cannot be broken by it: `[[pp-` … `]]` appears in no natural sentence,
and every field's alphabet excludes `;` and `]`. `by` is base64url because a
promoter identity is a human string and may contain quotes, semicolons, brackets
and newlines; encoding it removes an entire class of escaping bugs and lets the
regex stay strict. `at` is left readable because a person reading a note should
be able to see the date without decoding anything.

`sig` is **a checksum, not a signature**, and this is stated in the module header
and the dispute rather than glossed. Anyone with the repository can compute it.
It catches truncation and hand-editing, and it makes forging a record a
deliberate act rather than a typo. The real defence is structural: `of` must
match the rendition's own id, so a record cannot be copied between renditions,
and `buildRendition` **strips any promotion record found in caller-supplied
notes**, so the only code path that can write one is `promoteProvenance`.

**What L10 and L11 need from this.** Call `hasPromotionRecord(rendition)` before
trusting `'verified-by-user'`, and `verifyProvenance(rendition)` for the reason
when it fails. `renditionsRequiringLabel(renditions)` returns exactly the set the
artifact must render a visible label for: everything not `'client-supplied'`,
plus any `'verified-by-user'` whose record does not verify.

---

## D-L7-3 — Machine records in `notes` share one namespaced line convention

**Unsettled by:** Nothing in the spec; it follows from D-L7-2 needing a place to
live and other lanes wanting the same.

**Decision.** Any machine-readable record L7 writes into `Rendition.notes` is one
line of the form `[[pp-<kind>:<version>;<key>=<value>;…]]`, placed after human
prose, one record per line. Three kinds exist:

| kind | written by | read by | shape |
|---|---|---|---|
| `pp-promotion` | `promoteProvenance` | L10, L11 | D-L7-2 |
| `pp-budget` | `channel-variants` | L11, L12 | `[[pp-budget:1;channel=<id>;over=<n>;parts=<role>:<chars>/<limit>,…]]` |
| `pp-unsourced` | `runAdapter` | L11, L12 | `[[pp-unsourced:1;n=<count>;kinds=<a,b,…>]]` |

`readBudgetNote(rendition)` and `unsourcedNote(violations)` are the accessors.

**Why.** One convention beats three ad-hoc encodings, and a namespaced prefix
means a new record kind cannot be mistaken for an old one by a lane that has not
been updated. Keeping every record on its own line means `stripPromotionRecords`
and any future stripper can work line-wise, and a human reading the note in the
studio sees their own prose first.

---

## D-L7-4 — The §18.2 guard's exact boundary

**Unsettled by:** §18.2 states the law — "No fabricated metrics, logos of third
parties, testimonials, or named customers may be inserted by the tool. There is
no 'sample stat' generator. Ever." — but not what a checker for it does.

**Decision.** `assertNoFabricatedFacts(blocks, specimen, options)` returns an
array of violations; empty means clean. Every seed recipe template runs its own
output through the throwing form, `enforceNoFabricatedFacts`, before
`buildRendition` sees the blocks, so a template that grows a fabricated fact
fails at construction rather than in front of a client.

**What it catches.**

1. **New numerals.** A numeric token whose digits are absent from the source.
   Reformatting is permitted and recognised as such: a token is sourced if its
   digit sequence matches a source token's (`1,234.50` → `1.234,50`), or if its
   multiset of digit runs matches one (`08/17/2026` → `17.08.2026`). That is
   exactly the freedom `locale-fanout` needs and no more.
2. **New units on old digits.** `12` becoming `12%`, `$12` or `12x` is a
   fabricated statistic even though the digits did not change, so the symbol
   class must also match a source token carrying those digits.
3. **Spelled-out statistics.** `forty percent`, `three times`, `half … percent`
   when the phrase is not in the source.
4. **Testimonial-shaped strings.** Any `quote` block, and any quoted span of four
   or more words inside other text, whose folded form is absent from the source.
   Attributions are checked separately, because "— VP of Marketing, Acme" is the
   precise shape §18.2 forbids.
5. **Named third-party brands**, from a short documented list (`WATCHED_BRANDS`),
   flagged only when the source does not itself mention them.

**What it cannot catch**, stated plainly because the §20 critic will try:

- **Qualitative fabrication.** "The market leader in retail media" has no
  numeral, no quotation and no listed brand. Nothing here sees it. The templates
  structurally cannot write such a sentence — they emit source text plus a fixed
  structural lexicon — but a human using the paste surface can, and only a human
  reviewer will catch it.
- **A true number used falsely.** If the source contains `12%` in one context and
  a rendition asserts `12%` in another, the guard sees a sourced token. The block
  model carries no context to check against.
- **Brands outside the list.** It is a tripwire, not an ontology, and it is short
  on purpose: a long list produces false positives on the prospect's own partners
  and trains users to ignore the warning.
- **Media.** A fabricated logo arriving as an image is invisible; the guard reads
  text. `MediaRef.alt` is folded into the source bag, but no pixels are examined.
- **Numbers assembled across blocks.** `3` in one block and `x` in the next reads
  as two sourced tokens.

**The two deliberate relaxations, and why neither can carry a statistic.**

*The structural allowance.* Some numerals in a rendition describe the artifact
rather than the client — the three §4 breakpoint widths, the tile count in the
volume view, the character counts in a budget report. A template declares those
in `options.structural`, and an entry must be a **bare non-negative integer,
optionally suffixed `px`**. `enforceNoFabricatedFacts` *throws* on `42%`,
`$1,200`, `3.4x` or `1,800`, so the escape hatch cannot carry a unit, a currency
or a rate, and declaring `400` does not license `400%` — a test pins all of that.

*The identifier rule.* A digit inside a name measures nothing: `UCS-2`, `GSM-7`,
`UTF-8`, `H.264`, `MP3`, `Q4`. The rule requires uppercase letters running
straight into the digits or joined by a single `-` or `.`, not preceded by
another letter or digit, and never applies to a token already classified as a
percentage, a currency amount or a multiplier. `SAVE 20` does not match, because
a space is not a joiner. Its limit: a determined author could write `LIFT-40` and
be skipped, which is why it is written down here rather than left to be found.

**Why not a block-level exemption.** The obvious alternative — letting a template
mark whole blocks as "measurement chrome" where numerals are unchecked — was
rejected. A whole-block numeral exemption is exactly the hole a §20 critic should
drive a fabricated statistic through, and a future template author would reach
for it by habit. Both mechanisms above are too narrow to carry a claim: one
admits only dimensionless integers, the other only digits welded to a name.

**Provenance of this decision.** The identifier rule was added after an
integration smoke run: a source page containing no digits at all made the
`channel-variants` SMS report fail its own guard, because the report named its
encoding as `UCS-2` and the `2` read as a fabricated numeral.
`test/fixtures/recipe/specimens.mjs` now carries `digitFreeSpecimen()` and
`test/recipe/recipes.test.mjs` pins it.

---

## D-L7-5 — `buildRendition` downgrades silently; `promoteProvenance` throws

**Unsettled by:** §9 says nothing about what happens when a caller asks for a
provenance it may not have.

**Decision.** `buildRendition` returns `'illustrative'` when the caller asks for
`'verified-by-user'`, and when `producedBy` is `'adapter'` whatever was asked
for, without raising. `promoteProvenance` throws when `by` is empty or `at` is
not a valid ISO-8601 instant.

**Why.** They are different kinds of error. Asking `buildRendition` for
`'verified-by-user'` is a caller who does not know the law; the safe answer is to
apply the law, and the result is visible immediately because
`rendition.provenance` is not what was requested. Making it throw would push
callers toward try/catch around ordinary construction and toward passing
`'client-supplied'` to avoid the throw, which is worse.

A failed *promotion*, on the other hand, must never be silent. If
`promoteProvenance` returned the rendition unpromoted when `at` was malformed,
the user would believe they had verified something they had not — the §22.6
failure one step removed. So it throws, loudly, with the expected format in the
message.

`demoteProvenance` leaves the promotion record in `notes` on purpose: a record
sitting beside a non-verified provenance is honest history, and
`verifyProvenance` reports it as "promotion was withdrawn" rather than hiding it.

---

## D-L7-6 — L7 carries its own paste parser rather than depending on L3

**Unsettled by:** §9 requires a paste surface; `API.md` Part 3 declares L3's
`parseHtml`. Nothing says which parses clipboard HTML.

**Decision.** `src/recipe/paste.js` is a self-contained, tolerant HTML *fragment*
parser plus a Markdown-ish and plain-text reader. It does not import
`src/ingest`.

**Why.** Three reasons. Clipboard HTML is a fragment, routinely unbalanced
(`<p>One<p>Two`, an unclosed `<b>`, a truncated tail), and it must never throw —
a paste surface that fails on malformed input is not "excellent, not a fallback".
L3's parser is built for whole documents from ingest, where different tradeoffs
are right. And the paste path is the *default* path per §9: it must work with no
ingest pipeline present, which during parallel fan-out was literally the case.

The cost is a second HTML parser in the repository, which is a real cost and is
recorded as such. If a later pass consolidates them, the consolidation target
should be a fragment-tolerant mode on L3's parser, and this module's tests are
the acceptance criteria for it.

---

## D-L7-7 — Alignment is Needleman–Wunsch plus a bounded move-recovery pass

**Unsettled by:** §9 asks for "block-level alignment to the source specimen" and
names no algorithm.

**Decision.** Global Needleman–Wunsch over a block similarity in [0,1] that
combines type match (0.30), length ratio (0.20) and token overlap (0.50, the mean
of word-level and character-bigram Dice). Gap penalty `-0.55`. The substitution
score is `(similarity − 0.78) / (1 − 0.78)`, so an identical pair scores `+1` and
the break-even against a pair of gaps falls at similarity `0.538`. Traceback ties
resolve diagonal → insertion → deletion, walked backwards, which puts a dropped
source block *before* the block that replaced it in the returned pairing, the way
a unified diff reads. A move-recovery pass then pairs a leftover deletion with a
leftover insertion when their similarity is at least `0.62`, greedily by
descending similarity then by index. `score` is the summed similarity of matched
pairs divided by `max(sourceCount, pastedCount)`, so partial coverage cannot
reach 1.

**Why `0.78` and not something that looks like a similarity threshold.** Two
*unrelated* paragraphs of similar length already score `0.50` from the type and
length terms before a single word is shared. Any threshold below that pairs every
paragraph with every paragraph and never reports an insertion, which is precisely
the lie a side-by-side view must not tell. `0.78` puts the break-even at `0.538`:
comfortably above shape-only similarity, comfortably below a reworded version of
the same block, which lands at `0.65`–`0.80`. A test asserts the relationship
rather than the constant, so re-weighting the components cannot silently break it.

**Why move recovery at all.** A global alignment is monotonic by construction: it
*cannot* represent a block that moved, and reports it as a deletion plus an
insertion. For a paste surface that is a false statement about the user's own
content — the block is right there. Recovery is deliberately stricter than
ordinary matching (`0.62` against a `0.538` break-even) so it repairs relocations
without inventing correspondences. `alignBlocksDetailed` exposes a `moved[]` flag
so the studio can render a move as a move; `alignBlocks` returns exactly the
`API.md` shape.

---

## D-L7-8 — Channel budgets cite their source, and say when they have none

**Unsettled by:** §9.2 requires "per-channel length budgets enforced and visible"
and names no numbers.

**Decision.** Every limit in `src/recipe/budget.js` carries a `source` string,
and every budget carries `published: boolean`.

- **SMS** — 3GPP TS 23.038 / TS 23.040. 160 septets in one GSM-7 segment, 153 per
  segment concatenated (7 septets to the user-data header); UCS-2 at 70 and 67.
  `published: true`.
- **Email** — RFC 5322 §2.1.1 caps a header line at 998 octets. Display
  truncation is client behaviour, not a standard: Outlook for Windows around 60
  characters, Gmail desktop around 70, Apple Mail on iPhone in portrait around
  41. The budget uses 60 (the tightest desktop point) and the source string names
  all three. `published: true`. The body limit of 2000 characters is labelled a
  project convention *inside* a published-source budget, in its own `source`.
- **Paid social** — Meta Ads Guide: primary text truncates around 125, headline
  40, link description 30. LinkedIn: intro 150, headline 70. X: 280 per post. The
  budget takes the tightest of these cross-platform. `published: true`.
- **In-product message** — no vendor publishes a cross-product limit. Title 45,
  body 140, action 25, all explicitly `published: false` with the reasoning
  ("what fits one line of a 320px panel at 16px").

`maxWords` is derived as `floor(maxChars / 5.7)` — mean English word length 4.7
letters plus one space — and the character count is always the authority.

**Why.** A slide that says "and it fits SMS" while showing 400 characters is
worse than no slide, and a slide that quotes a made-up limit as if it were a
standard is worse still. Marking the one budget that is a convention as a
convention costs nothing and is the difference between a tool a marketing
operations lead trusts and one they catch out.

---

## D-L7-9 — SMS is measured in the encoding the copy actually forces

**Unsettled by:** §9.2 says budgets are enforced and visible. It does not say what
happens when a single character changes the budget.

**Decision.** `enforceBudget` detects GSM-7 versus UCS-2 for the SMS channel and
measures against **that encoding's** single-segment size — 160 or 70 — reporting
the encoding, the septet count and the segment count. The overage is computed
against the encoding-appropriate limit, not the flattering one.

**Why.** One em dash, one curly apostrophe or one accented name drops the
single-segment budget from 160 to 70 and doubles the send cost. Reporting `160`
next to a message that will actually fragment is the kind of quiet inaccuracy the
whole tool exists to remove. It is also the most useful thing on the slide: it is
a real, checkable, slightly surprising fact about the prospect's own copy.

---

## D-L7-10 — `enforceBudget` does not truncate by default, and never truncates silently

**Unsettled by:** `API.md` declares `enforceBudget(blocks, budget): {blocks, overBy}`.
Whether `blocks` comes back cut is not stated.

**Decision.** By default nothing is cut: the blocks come back unchanged with a
budget report table appended and `overBy` measured exactly. With
`{truncate: true}` the over-budget parts are cut on a word boundary, blocks that
lose all their text are dropped, and the report names the exact character count
removed. `overBy` is measured against the *original* content in both modes.

**Why.** §13's degradation rule — "Report exactly what was degraded and by how
much — never silently" — is about assets, but the principle is the product's. A
studio user pasting their own copy and finding it shortened without being told
would rightly stop trusting the tool. Making truncation opt-in and always
reported keeps the default honest and the option useful.

---

## D-L7-11 — `locale-fanout` reformats and restructures; it never translates

**Unsettled by:** §9.1 asks for "nine market renditions with locale-appropriate
structure, not just translated strings". It does not say what to do about the
strings.

**Decision.** The recipe never translates. It reformats the specimen's own dates,
numbers, currency placement, quotation marks and typographic spacing into each
market's conventions, and it restructures the page: writing direction (RTL prose
becomes `raw` blocks carrying `dir="rtl"`, and table cell order is mirrored),
legal-line placement (above the call to action for Germany and Japan, in the
footer elsewhere), and a per-market format contract table stating the date
pattern, number pattern, currency position, name order, address field order,
plural categories, quotation marks and punctuation spacing. Where the source has
no legal line, the rendition shows a **labelled empty slot**, never a plausible
German address.

**Why.** The tool has no translator, and inventing one would be inventing
content — §18.2 in its most tempting form, because translated marketing copy on a
slide looks impressive and nobody in the room reads Japanese. Reformatting is
verifiable: every digit that comes out was in the source, which is why the §18.2
guard passes it and why the fan-out survives a localisation lead asking "what
actually changed?". A page that is genuinely restructured nine ways is a stronger
answer than nine translated cards, because it is the part the audience's own
teams find hard.

Date parts are never zero-padded or unpadded during reordering: `8/5/2026` stays
`8`, `5`, `2026` in Japanese order. Padding would add a digit the source never
had, and the guard would be right to call that fabrication.

**RTL as `raw`.** §8 says raw HTML must not be presented without an opt-in per
specimen. The `raw` blocks here are balanced, self-contained, script-free
elements this module constructed and escaped, not source HTML — the opt-in rule
is about presenting the *prospect's* markup unexamined. `cta` blocks stay `cta`
so layouts can render them as controls.

---

## D-L7-12 — Templates are `producedBy: 'template'` and `provenance: 'illustrative'`

**Unsettled by:** §4 defines `producedBy: 'manual-paste' | 'adapter' | 'template'`
and §9 stamps only adapter output.

**Decision.** Every rendition a seed recipe produces is `'template'` and
`'illustrative'`, and therefore labelled in the artifact.

**Why.** A template rendition contains only the prospect's own words, rearranged
— but the *arrangement* is the tool's, and the arrangement is the claim being
made on the slide. §22.6 is about implication, not about wording, and the honest
position is that the tool arranged it and says so. A user who has checked a
rendition promotes it, one at a time, and the label goes away because a person
took responsibility for it. See dispute DL7-5 for why a fourth `Provenance` value
would let the artifact word those two cases differently.

---

## D-L7-13 — `assertNoAdapterSecrets` returns findings and holds fingerprints, not keys

**Unsettled by:** §9 requires the emitter to assert a key's absence. Nothing says
what the assertion returns, or how it can recognise a key it must not store.

**Decision.** `assertNoAdapterSecrets(value)` returns `string[]`, empty meaning
clean, matching `validateProofShape`'s house style — L10 turns a non-empty result
into a `Finding`. It never throws for a finding. `runAdapter` records a SHA-256
**fingerprint** of each configured key in a module-private set;
`forgetAdapterSecrets()` clears it.

Three checks: an exact fingerprint match against any string or any token inside a
string; a property *name* that is adapter configuration (`key`, `token`,
`authorization`, `endpoint`, …) with a non-empty string value; and value shapes
that read as credentials anywhere (`sk-…`, a bearer header, a JWT, an AWS key id,
a GitHub or Slack token).

**Why a fingerprint and not the key.** The key must live "in memory and IndexedDB
on their machine only". A module-level variable holding the key would technically
satisfy that and would be a standing liability — anything that ever serialised
this module's state would leak it. A SHA-256 cannot be reversed but can be
compared, which is all the absence proof needs. It is also the check that
actually matters: it finds the *user's real key*, whatever its format, wherever
it ended up.

`endpoint` is treated as a secret-shaped property name even though a URL is not a
secret, because an endpoint in a proof is also a `NETWORK_REFERENCE` and has no
business being there either way.

**What it cannot do:** recognise an unknown-format key this session never
configured, that matches no listed shape, under an innocuous property name. Check
one is exact and is the one that matters.

---

## D-L7-14 — The adapter surfaces unsourced values rather than rejecting them

**Unsettled by:** §18.2 forbids *the tool* inserting fabricated facts. It does not
say what to do when a user's own configured generation endpoint returns one.

**Decision.** `runAdapter` runs the §18.2 guard over the endpoint's output,
returns the rendition anyway, and records the result in `notes` as prose plus a
`[[pp-unsourced:1;n=…;kinds=…]]` machine line. Templates, by contrast, *throw*.

**Why.** The adapter is the user's own pipeline against their own endpoint, and
the rendition is stamped `'illustrative'` and labelled in the artifact regardless.
Silently discarding their output would be a tool deciding it knows better, and
the user would simply paste the same text through the manual surface, where the
guard does not run at all — a rule that is easy to route around teaches people to
route around it. Surfacing it puts the finding where a reviewer sees it and where
L11 can raise it in preflight. Templates throw because a fabricating template is a
defect in this repository, not a runtime condition.

---

## D-L7-15 — `volume-view` is the only place L7 draws randomness, and it is seeded

**Unsettled by:** §9.8 asks for "1 → 40 → 400 renditions as a density visual" and
does not say what fills the tiles.

**Decision.** Each tile is one locale crossed with one channel code, drawn from
this lane's own `LOCALES` and `CHANNEL_BUDGETS`. Tile order comes from the
`recipe/volume-view` PRNG substream (§5's naming convention), reshuffling when the
tier exceeds the 36 available combinations. Every other recipe is fully
deterministic without any PRNG draw at all.

**Why.** The tiles must mean something or the visual is decoration, and the
combinatorial space the other seven recipes actually cover is the meaningful
thing to show. Shuffling stops the grid from reading as nine repeating stripes
while keeping it reproducible from the project seed. The rendition states out
loud that tiles repeat past the combination count, because a grid of 400 that
silently implies 400 distinct outputs would be the same category of
overclaim §18.2 exists to prevent.

---

## D-L7-16 — Exports beyond the `API.md` L7 surface

**Unsettled by:** `API.md` permits adding exports and declares nine for L7.

**Decision.** `src/recipe/index.js` exports everything `API.md` declares, plus:

| export | who needs it |
|---|---|
| `renderRecipe(recipe, specimen, options): Result<Rendition[]>` | **L12 and integration — this is how a caller actually gets renditions out of a recipe.** `API.md` declares the recipe list and `buildRendition` but no way to run a recipe. |
| `renderAll(specimen, options)` | L12's "populate the library" action; the integration smoke test |
| `RECIPE_TEMPLATES`, `recipeAccepts`, `recipesFor` | L12's recipe picker, gated on specimen kind |
| `hasPromotionRecord`, `readPromotionRecord(s)`, `verifyProvenance`, `renditionsRequiringLabel` | **L10 and L11 — §22.6 enforcement** |
| `assertNoAdapterSecrets`, `noteAdapterSecret`, `forgetAdapterSecrets` | **L10's absence proof**; L12's settings panel |
| `assertNoFabricatedFacts`, `enforceNoFabricatedFacts` | L11's preflight; L12's paste surface |
| `alignBlocksDetailed`, `blockSimilarity` | L12's side-by-side view, which needs the `moved[]` flags |
| `CHANNEL_BUDGETS`, `smsSegments`, `LOCALES`, `localizeText` | L12's inspector |

**Why.** Each is something another lane cannot do without. `renderRecipe` is the
notable gap in the declared surface and should be added to `API.md` at
integration; the rest are enforcement and inspector surfaces that follow from the
laws L7 owns.

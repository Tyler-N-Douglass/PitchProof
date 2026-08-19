# L12 Studio UI — disputes

Objections to a §4 contract, an `API.md` surface, or a shared script. Per the
process rule, **every one of these is built against as written**; nothing below
was worked around in `src/ui/**`.

---

## D-L12-1 — `scripts/build.mjs` corrupts the studio bundle — RESOLVED

**Status: fixed by the integrator.** `buildStudio` now passes function
replacements, `dist/pitchproof-studio.html` parses and runs, and
`test/ui/shell.test.mjs` pins both halves: the assembled document compiles, and
the bundle still contains the `$`-sequences that made a string replacement
unsafe. Kept here for the record.

**Where.** `scripts/build.mjs`, `buildStudio()`:

```js
return shell
  .replace('<!--PITCHPROOF_STYLES-->', `<style>\n${css}\n</style>`)
  .replace('<!--PITCHPROOF_RUNTIME-->', embedded)
  .replace('<!--PITCHPROOF_SCRIPT-->', `<script>\n${code}\n</script>`);
```

**What goes wrong.** `String.prototype.replace` with a *string* replacement
expands `$$`, `$&`, `` $` ``, `$'` and `$n` inside the replacement. Three files
in the tree legitimately contain those sequences:

| File | Occurrence |
|---|---|
| `src/core/text-metrics.js` | a character table containing `'$'` |
| `src/emit/scan-parse.js` | the same |
| `src/runtime/host.js` | `String(value).replace(/["\\]/g, '\\$&')` in `cssEscape` |

Each `$'` in the bundle is replaced by *everything in the shell after the
marker*, which splices `</script></body></html>` and the boot script into the
middle of a string literal. Chromium reports `Invalid or unexpected token` twice
and `Unexpected identifier 'type'`, `PitchProofStudio` is never defined, and the
studio renders its own "the studio bundle did not load" fallback.

**The fix, in the file I may not edit** — pass a function so the replacement is
inserted literally:

```js
return shell
  .replace('<!--PITCHPROOF_STYLES-->', () => `<style>\n${css}\n</style>`)
  .replace('<!--PITCHPROOF_RUNTIME-->', () => embedded)
  .replace('<!--PITCHPROOF_SCRIPT-->', () => `<script>\n${code}\n</script>`);
```

Three characters per line. Nothing else changes; the build stays deterministic
and `--verify-repeat` still passes.

**Evidence that this is the whole of it.** With exactly that change applied in a
scratch copy of `buildStudio` (and no change at all to `src/`), the studio loads
in headless Chromium with **zero page errors, zero console errors and zero
network requests**, and the full §1.2 flow completes keyboard-only: paste a page
→ specimen, load the eight recipes → paste a rendition, add scenes and plan
beats, add three branches, review the brand, `Alt+R` sweep clean, `Ctrl+Enter`
emit (486 KB, deflate), save `Northwind-Industrial.pitchproof.html`.

**Not worked around.** `src/ui/shell.html` and `src/ui/**` are written against
`buildStudio` exactly as it stands. The corrupting sequences are in L1, L2 and
L10 sources, not in mine, and there is nothing `src/ui/**` can do about a
replacement string it does not produce.

---

## D-L12-2 — `API.md` L6 declares `restoreBlock` but not the field it restores from

**Severity: cosmetic; already resolved by the lane.**

`API.md` Part 3 declares `restoreBlock(specimen, removedEntry)` and
`stripChrome(...) → {root, removed}`, but does not say where a specimen keeps its
removed entries between a capture and a later session. §8 requires the studio to
show "the chrome-stripping result... and every stripped block restorable", which
needs that state to survive a save.

L6 landed `Specimen.stripped[]` (with `reason`, `score`, `selector`, `text`,
`blocks`, `positions`) as an optional extension, which is exactly right and is
what the Specimens panel reads. Recording it here only so the next reader of
`API.md` does not conclude the field is the studio's invention.

---

## D-L12-3 — `API.md` L6 has no declared surface for building `ImageSample`s

**Severity: functional gap; worked around honestly.**

L5's `classifyImagery(images)` takes decoded RGBA samples. No surface declared in
`API.md` Part 3 turns a captured `{name, bytes, mime}` asset into one. L6 exports
`decodePng` as a lane extension, but rule 1 restricts a lane to the *declared*
surfaces, so the studio does not reach for it.

Consequence: imagery is classified from no samples, comes back `unknown` at zero
confidence, and is held by §7's review gate for a person to set by hand. That is
correct behaviour rather than a failure — see `docs/decisions/L12-ui.md` L12-7 —
but it is less than §7 asks for.

**Status:** the seam is built and waiting. `services.imagerySamples(assets)`
already looks for `sampleFromPng` on L5's declared surface and maps every PNG
asset through it; it returns `[]` only because the export is not there yet. The
integrator has asked L5 to re-export `sampleFromPng` from `brand/theme.js`; when
it lands, imagery starts being classified with **no further change to
`src/ui/**`**, and `test/ui/lane-conformance.test.mjs` will require it to be
consumed.

---

## D-L12-4 — `ingestFiles` is the studio's real need but is a lane extension

**Severity: none; noted for the record.**

`API.md` L3 declares the importers individually (`importSavedPage`, `importHar`,
`importMhtml`, `importOoxml`, `importPdf`, `importImage`, `importHtmlText`). A
file drop needs routing across all of them, including attaching a saved page's
`_files/` folder to the page it belongs to. L3 landed `ingestFiles(files, deps)`
which does precisely that, and `services.importFiles` calls it, because writing a
second router in the studio would be a worse copy of L3's.

If the integrator prefers the studio to stay strictly on the declared set, the
fallback is to promote `ingestFiles` into `API.md` Part 3 — which is what it
already is in practice. Meanwhile the six importers it routes to are declined
individually in `LANE_SURFACE_NOTES` with that reason, so the consuming-side
conformance test records the decision rather than hiding it.

---

## D-L12-5 — §4 gives no field for "who reviewed this brand group, and when"

**Severity: minor; extension used.**

§9's promotion record names who and when. §7's review gate has the same shape of
obligation — an emit is released on a human's judgement — but §4 gives
`BrandSystem` only `manualOverrides: string[]`, which records *editing*, not
*reviewing*, and the two are different acts: looking at a low-confidence field
and accepting it changes nothing.

The studio stores `BrandSystem.reviewedGroups?: string[]` as an optional
extension. It does not record who or when, because §4 has nowhere to put that and
inventing a nested object felt like more drift than the problem warrants. If the
critic wants review parity with promotion, the smallest honest change is
`reviewedBy?: {group, by, at}[]`, and the studio would fill it from the operator
name it already collects for §8 and §9.


---

## D-L12-6 — `API.md` Part 3 is enforced from one side only

**Severity: process; fixed on this lane's side.**

`test/core/api-conformance.test.mjs` checks that each lane exports what it
declared. Nothing checked that anything consumed it, and that asymmetry is
exactly how §9's seed recipe library came to be built, tested, published and
unreachable from the studio for a whole pass (CRITIQUE-1 F14).

`test/ui/lane-conformance.test.mjs` now closes it for L12: every surface Part 3
declares for a lane the studio imports must be called in `services.js` or
explained in `LANE_SURFACE_NOTES`. **The same asymmetry exists for every other
consuming lane** — L6 consumes L3, L7 consumes L6, L8 consumes L4/L5, L10 and
L11 consume L8/L9 — and each of them could carry the same twenty-line test. That
is the integrator's call, not this lane's, but F14 is unlikely to be the only
instance of it.

---

## D-L12-7 — Should the emit gate let a seller sign off the studio's own starting brand?

**Severity: product judgement; raised, not taken. Built as written.**

A brand-new project ships with four colour roles (`#FFFFFF`, `#111318`,
`#1F3A93`, `#FFFFFF`) and one face (`system-ui`) from `model.emptyBrand`, all at
0% confidence. They exist so the Brand panel has something to render and so a
proof is previewable before an extraction.

They are also, until someone extracts or types over them, **not the prospect's
brand**. Under §7 they sit below the confidence floor, which means they appear
as an emit blocker — and the blocker is released by one checkbox. A seller who
ticks it emits an artifact wearing PitchProof's navy and `system-ui` while §15
says "the artifact wears the prospect's brand".

This pass fixed the *wording* (L12-18): the blocker is now `BRAND_DEFAULTS`, it
says nothing has been extracted and nothing entered, and the checkbox says what
ticking it accepts. The group is still reviewable, on the ground that a person
looking at four hex values and accepting them is making a real judgement about a
real claim, which is what distinguishes this from L12-15's "reviewing an empty
set is not a review".

**The stronger option, for the integrator.** Refuse review of a group that is
still exactly `emptyBrand`'s value — `setBrandReviewed` already refuses an empty
group, and `brandGroupIsStarterDefault` is exported and tested, so the change is
one clause. The effect is that a new project cannot emit until the brand has been
extracted or at least one field entered by hand, which §1.2's definition of done
requires anyway ("Extract their brand system"). The reason this lane did not just
do it: it closes the emit on a fresh project on §18 grounds the spec states about
the artifact rather than about the gate, and a gate that gets stricter is the
integrator's call rather than one panel's.

**Not worked around.** Nothing in `src/ui/**` assumes either answer;
`brandGroupIsStarterDefault` is a predicate, and the three call sites read it
rather than branching on a copy of it.

---

## D-L12-8 — `PROMOTION_RECORD_LIMIT` is the right thing to show and is not in `API.md` Part 3

**Severity: none; noted for the record, same shape as D-L12-4.**

CRITIQUE-1 F23 found `promotionSignature` to be an unkeyed `shortHash` with
`formatPromotionRecord` exported, so a valid promotion record can be computed by
anyone holding the repo. §1.1 forbids a backend and accounts, so no key scheme
can do better — any key would ship inside the artifact the forger already has.
The digest is tamper-evidence against corruption and partial edits; it is not
proof of who promoted anything. L7 accepted the finding and exported
`PROMOTION_RECORD_LIMIT`, one canonical sentence saying exactly that.

`API.md` Part 3 declares nine surfaces for L7 and this is not among them. The
studio consumes it anyway — `services.promotionRecordLimit()` returns it verbatim
and the Recipes panel renders it beneath the "verifies against itself" badge —
because the alternative is the studio writing a second description of the same
guarantee, which is the exact mechanism by which `services.promotionRecord`'s own
comment came to claim the record "cannot be hand-forged" and stay wrong for a
pass.

If the integrator prefers the studio to stay strictly on the declared set, the
fix is to promote `PROMOTION_RECORD_LIMIT` into `API.md` Part 3 — which is what
it already is in practice, since L7's module header names it as "the sentence to
show". `test/ui/empty-state-honesty.test.mjs` asserts the studio returns L7's
string identically, so a paraphrase reappearing fails.

**Worth stating for whoever reads F23 next:** the digest is not the weakest link
in the provenance chain. Setting `provenance: 'client-supplied'` suppresses the
illustrative label with no record at all — one word rather than six fields and a
hash — and that is a deliberate, labelled act by the operator, which is the model
§9 chose. The correction F23 asks for is a wording correction, not a security
one.

---

## D-L12-9 — `attachUserFont` is the only route §7 permits and is not in `API.md` Part 3

**Severity: none; noted for the record, same shape as D-L12-4 and D-L12-8.**

CRITIQUE-2 C3 asked for a route that accepts a font file. L5 publishes exactly
the right one: `attachUserFont(faces, supply, {clock})` refuses without a file
and refuses without a rights assertion naming who made it, and its module header
calls itself "the **only** function in the product that can set
`TypeFace.embeddable` to true". `src/ui/services.js` now consumes it, and
`src/ui/panels/brand.js` renders the control that reaches it.

`API.md` Part 3's L5 fence declares seven surfaces and this is not among them;
it appears only in the "extra published surfaces" table further down, as *"the
only route to `embeddable: true` (§7)"*. So `test/ui/lane-conformance.test.mjs`
— which reads the fence — neither required the studio to wire it nor required a
reason for declining it, and for a whole pass the studio declined it silently.
That is the same asymmetry the conformance test was written to close, one level
out: the test polices the fence, and the surface that mattered most here was
outside it.

**What this lane did:** consumed it as published, with no local reimplementation.
`services.attachUserFont` is a three-line pass-through with the clock injected,
so the refusals are L5's.

**For the integrator:** promoting `attachUserFont` into the L5 fence in
`API.md` Part 3 would put it under the conformance test, and the same argument
applies to `PROMOTION_RECORD_LIMIT` (D-L12-8). Both are surfaces the studio must
use to satisfy a spec clause; neither is declared where the test that enforces
consumption can see it.

---

## D-L12-10 — L11 reads `embeddable` as ground truth, which is correct and worth stating

**Severity: none; a note about a coupling, not an objection.**

`src/validate/overflow.js:151` builds the available-family list from
`face.embeddable`, so a face flagged embeddable is treated as present on the
client's machine and FONT_UNAVAILABLE is not raised for it. That is the right
reading — §7 makes the flag mean "the user supplied a file" — and it is precisely
why CRITIQUE-2 C3 was severity 2 rather than cosmetic: one unfounded flag
silenced the warning *and* changed what overflow was measured against.

L12 now holds up its end: the flag is set only by L5's `attachUserFont`, no
control can set it directly, and a record arriving with the flag and no file has
it cleared on load (`model.clearUnfoundedFontClaims`, announced to the user).

**Not a request for a change.** A defensive check in L11 — "embeddable, but is
there a `fontFile`?" — would be a second, weaker copy of §7's invariant living in
the lane that consumes it rather than the lanes that maintain it. Recorded so
that whoever next reads `availableFamilies` knows the invariant is enforced
upstream on purpose, and where.


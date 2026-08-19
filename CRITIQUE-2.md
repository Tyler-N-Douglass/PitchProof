# CRITIQUE-2

Adversarial critic, pass 2, against `PITCHPROOF-BUILD-SPEC-v1.0.md` §20.

**Verdict: 9 axes pass, 2 fail. 1 severity-1 finding, 7 severity-2, 8 severity-3.
The product now works end to end. Two measurement engines lie about their own
results.**

The build my predecessor found unusable is gone. I pasted a URL into the built
studio, got 14 colour roles, 2 faces and 2 logos, captured four pages, ran the
seed library to 29 renditions, assembled eight scenes and three branches, swept
clean, and emitted a 383 kB artifact that opens offline — all of it keyboard-led,
in one sitting, from `dist/pitchproof-studio.html`. §1.2 is met. All 24 of
CRITIQUE-1's findings that I spot-checked are genuinely closed, not papered over.

What is left is subtler and worse for it. Two subsystems now report confidently
on work they measure wrongly. The overflow detector — §22.2's "highest-value
check in the entire tool" — misses **33 of the 95 text boxes that a real
Chromium actually cuts** on the corpus spine, including six scene headlines,
because it measures the scene header against the full stage width while the
layout gives the headline a third of it. And the size budgeter under-counts the
artifact's own asset payload by a factor of two, which makes it refuse budgets it
could meet, degrade images to a quarter of the size the budget allowed, and
report exactly half the bytes it actually saved.

Both are the same failure mode: a model of the artifact that has drifted from the
artifact, in the two places where the spec asks for a measurement rather than an
assertion.

---

## §20 axis scorecard

| # | Axis | Verdict |
|---|---|---|
| 1 | Contract fidelity | **PASS** |
| 2 | Determinism | **PASS** |
| 3 | Colour correctness | **PASS** |
| 4 | Offline integrity | **PASS** |
| 5 | Overflow detection efficacy | **FAIL** — C1 |
| 6 | Branch integrity | **PASS** — with C5 |
| 7 | Provenance enforcement | **PASS** — with C9 |
| 8 | Presentation robustness | **PASS** |
| 9 | Degradation honesty | **FAIL** — C2 |
| 10 | Studio usability under pressure | **PASS** — with C3, C6, C7, C11 |
| 11 | Non-goal violations | **PASS** |

---

## §20 preamble: what I ran before writing

> "The critic must actually build and present a proof end to end from the
> fixture corpus before writing its report."

I built the corpus proof through the whole pipeline, emitted it, opened it in
headless Chromium from `file://` with every non-`file://` request aborted, walked
all 99 spine positions with real key presses, and looked at 31 scene screenshots
plus 31 last-beat screenshots. Then I built a second proof through the **built
studio** (`dist/pitchproof-studio.html`, the deployed file, not `src/`) from
paste-a-URL to saved artifact.

Everything is under
`/tmp/claude-0/-home-user-PitchProof/4f4867db-5fdf-5b7b-bf15-0e36c8d8a775/scratchpad/c2/`.

| Script | What it did |
|---|---|
| `01-emit.mjs` | `buildCorpusProof()` → `emit()`. 31 spine scenes, 4 branches, 6 specimens, 31 renditions, 597,222 bytes, deflate. |
| `02/03/04-*.mjs` | The artifact in Chromium: 99 positions, 31 scenes, screenshots of every scene at beat 0 and at its last beat, per-element clipping measured in the DOM. |
| `05-media.mjs` | Every `<img>` in the deck: 9 scenes carry images, zero broken. |
| `06-network-plants.mjs` | 27 network references planted in the finished HTML — iframe, meta-refresh, srcset, CSS `url()`, `@import`, `@font-face src`, form action, preconnect, `<base>`, `ping`, `<use xlink:href>`, poster, track, embed, object, importmap, module `import()`, inline `fetch`/`sendBeacon`/`new Image`/`WebSocket`, `onload`, protocol-relative, `data-endpoint`, string-split `fetch`, base64-obfuscated `WebSocket`. |
| `07/08-*.mjs` | 13 more planted **through the model** — raw blocks, CTA hrefs, swapped `dataUri`, a logo pointing at a URL, an SVG logo with a foreign `<image>`, a presenter note, a headline carrying `<script>`, a table cell, `og:image`. |
| `09/10/11-*.mjs` | 17 branch orphans and id collisions built by hand, each through `runPreflight` and `emit()`. |
| `13/14/16-*.mjs` | 30 routes to unlabelled illustrative content: label off at emit, in `proof.emitOptions`, in Review mode, forged `verified-by-user`, a hand-forged promotion record, and 18 stylesheet attacks on the label through `userCss` and `themeCss`, each measured in a real browser. |
| `12-project-io.mjs` | §16 export/import round trip plus 10 hostile project files. |
| `30–34-*.mjs` | §6 ingest, every strategy: `ingestUrl`, `.har`, `.mhtml`, saved page, paste, `.docx`, `.pptx`, `.pdf` — each graded on what the brand engine gets out of it. |
| `35/36-*.mjs` | §6.2 CORS proxy end to end, and §9's runtime adapter including an endpoint that echoes the API key back. |
| `40-persist.mjs` | IndexedDB across a reload, twice, in a persistent Chromium profile. |
| `41-quota.mjs` | §16 storage pressure, eight saves against a 400 kB quota. |
| `50-plants.mjs` | All nine `PLANTS` through `runPreflight`, scored against the corpus baseline. |
| `51/52/53-*.mjs` | **The overflow ground truth**: every `data-pp-tx` box in the artifact measured in Chromium at 390×844, 1024×768 and 1600×900 — the engine's own `BREAKPOINTS` — compared box-by-box with what `runPreflight` reported. |
| `60/61/62-*.mjs` | Size budgeting forced at five budget fractions, with the file's data URIs counted independently. |
| `70-dryrun.mjs` | Auto-fix buttons and dry-run mode (`Alt+D`) in the built studio. |
| `71/72/73-*.mjs` | The `ar-SA` locale rendition, rendered and screenshotted. |
| `80/81/82-*.mjs` | A four-deep nested branch chain built by hand, driven by keyboard: jump index, `r`, `Backspace` unwinding, blank screen, all four overlays, forward-then-back from every beat. |
| `90/91-*.mjs` | Byte-identical emit across five processes and three timezones; OKLab and WCAG checked against published values with an independent implementation. |
| `20–24-*.mjs` | The whole §1.2 flow in the built studio. |

**Gate results, re-run by me:**

```
node --test "test/**/*.test.mjs"                1897 pass, 0 fail
node scripts/lint-determinism.mjs               clean
node scripts/build.mjs --verify-repeat 3        3 output(s) byte-identical
node scripts/verify-offline.mjs                 clean — 0 requests, FCP 100ms/96ms,
                                                510 key presses / 111 positions, both decode paths
```

All four agree with the integrator's numbers. None of them detects C1 or C2.

---

## Severity 1

### C1 · The overflow detector misses a third of the text the artifact actually cuts

`src/scene/geometry.js:246-247`, `src/scene/parts.js:212-227`,
`src/scene/measure.js:172` (`boxGeometry(slot, bp, params)`).

§17.4 sets a number: *"assert recall ≥ 0.98 for severity-1 overflow."* §22.2
calls this the defect that "makes a proof look amateur in front of a CMO, and it
is invisible until it isn't."

I measured it. Every element carrying `data-pp-tx` in the emitted corpus
artifact, in Chromium, at the three viewports `BREAKPOINTS` itself declares
(390×844, 1024×768, 1600×900), walking the whole spine
(`52-overflow-detail.mjs`):

```
spine boxes Chromium reports as not fitting:      105
of those, matched by a runPreflight finding:       62
unmatched:                                         43
unmatched AND genuinely cut
  (overflow:hidden / -webkit-line-clamp / ellipsis): 33
                                          missed by breakpoint: sm 17, md 10, lg 6

recall over everything Chromium cuts:  62/95 = 0.653
recall over all overflow:              62/105 = 0.590
```

Against §17.4's 0.98. The worst individual cases, verbatim from the run:

```
sm  sc_853b7f0ca59f  headline   overW=48  overH=75  cw=152 ch=51  clamp=2
      "Vom Reinigungsintervall her denken, nich…"
sm  sc_437d80e0181d  noteLabel  overW=116 cw=5   ch=11  ws=nowrap  to=ellipsis
      "Channel variants 4/6"          ← a 5px box holding 121px of text
md  sc_1e593b179168  panelMeta  overW=418 cw=441 (95% over)  to=ellipsis
md  sc_e09238b5fe7e  panelMeta  overW=160 cw=525 (30% over)  to=ellipsis
lg  sc_1e593b179168  panelMeta  overW=299 cw=638 (47% over)  to=ellipsis
```

`53-shots.mjs` screenshots them. `cut-sc_853b7f0ca59f-sm.png` shows the German
article's scene headline reading **"Vom Reinigungsi…"** — cut after fifteen
characters — with the preflight silent on `headline` for that scene at any
breakpoint. `cut-sc_1e593b179168-md.png` shows the mono source chip reading
"Designing fouling margin you will actually use — Northwind Indus…".

**Root cause, and it is one line of geometry.** `sceneHead` renders

```js
// src/scene/parts.js:217-227
h('header', { class: 'pp-scene-head', 'data-pp-box': 'head', … },
  h('div', { class: 'pp-scene-head-text' },
    …kicker,
    h('h2', { class: 'pp-headline', 'data-pp-tx': 'headline', 'data-pp-clamp': '2' }, scene.headline),
    h('p',  { class: 'pp-subhead',  'data-pp-tx': 'subhead',  'data-pp-clamp': '2' }, scene.subhead)),
  options.extra || null);          // ← a sibling in the same flex row
```

and the geometry table gives the whole `head` box the full stage width:

```js
// src/scene/geometry.js:246-247
case 'head':
  return { widthPx: s.contentWidthPx, heightPx: s.headHeightPx };
```

`options.extra` — the mono source chip visible on the right of every screenshot —
is a flex sibling of `.pp-scene-head-text`, and nothing subtracts it. At `sm` the
model hands `headline` 350px; Chromium hands it 131–160px. There is no
`data-pp-frac` or `data-pp-inset` on the text column to close the gap, so the
detector is measuring a box that does not exist. The same class of error explains
the `panelMeta` misses at `md`/`lg`: the model has a width for that slot at `sm`
and a different, wrong one above it.

**Why the gates do not see this.** Everything upstream is self-consistent:
`measureScene` measures the tree `renderSceneTree` produced against the table
`boxGeometry` declares, and the unit tests assert the two agree. Nothing in the
suite ever compares either against a browser. `verify-offline.mjs` loads the real
artifact in a real Chromium and never measures a single box.

**Consequence in the room.** The artifact the four gates certify carries 72
`TEXT_OVERFLOW` findings, all severity 2, and ships. Thirteen of them are at
`lg` — the presentation breakpoint — and thirty-three more are not reported at
all. `last/l04-sc_a668c378d053-pp-scene.png`, at 1440×900, shows the prospect's
own page title as "Northwind Industrial — Process equ…" and their own headline as
"Equipment that stays running, in plants that…". That is §22.2 happening, in the
reference deck, past every gate.

I am filing the detector's recall as the severity-1 finding, not the deck's
appearance: the deck is a fixture and can be rewritten, but a measurement engine
that is confidently wrong about a third of its subject is the thing that will
ship a broken proof on a real brand.

---

## Severity 2

### C2 · The size budgeter counts the artifact's assets once and the file carries them twice

`src/emit/emit.js:125-126`, `src/emit/budget.js:119` (`collectAssets`).

```js
const assetBytes = collectAssets(working).reduce((sum, a) => sum + a.bytes, 0);
const reserveBytes = Math.max(0, built.bytes - assetBytes);
```

The reserve is meant to be "what the document costs before assets". It is not.
Measured directly (`62-reserve.mjs`, corpus proof plus six 700×480 PNGs added
through `Specimen.media`):

```
collectAssets total (what the budgeter subtracts):   8,036,488 bytes
data: URIs actually present in the emitted file:    16,045,814 bytes  (19 URIs, 12 distinct)
emitted file:                                       16,636,725 bytes
true non-asset overhead:                               590,911 bytes
reserveBytes the emitter computes:                   8,600,237 bytes   ← inflated by ~8.0 MB
```

Every asset that appears both in the first-paint markup and in the model payload
is counted once and paid for twice. Three consequences, all reproducible:

**1. It refuses budgets it could trivially meet.**

```
maxBytes = 16,636,724  (one byte under the natural size)
  → emit refused: 1 severity-1 finding — 1 × SIZE_BUDGET_EXCEEDED
```

**2. It throws away image quality it did not need to.**

```
maxBytes = 13,309,380 → file  9,967,605  (74.9% of budget, 3.34 MB of headroom unused)
maxBytes =  9,982,035 → file  3,235,268  (32.4% of budget, 6.75 MB of headroom unused)
                        700×480 images resampled to 350×240
```

In a wider sweep (`60-degrade.mjs`, 14 planted images) a 10.79 MB budget produced
a 1.01 MB file with images at **84×57** — and budgets of 45% and 30% produced
byte-identical output, because the plan had already hit the floor.

**3. The degradation report understates the savings by exactly a factor of two,
at every budget.** §17.10: *"assert that the reported degradation matches actual
bytes saved."*

```
budget 0.90  reported saved  2,469,240   actual  4,938,196
budget 0.75  reported saved  5,996,444   actual 11,992,197
budget 0.60  reported saved  9,629,456   actual 19,258,125
budget 0.45  reported saved 11,483,000   actual 22,965,122
```

The report is honest about *which* assets it degraded and by how much on each
asset — `predictedBytes` sits within 10% of `actualBytes` on every line — so this
is not the silent quality loss §13 forbids. It is a report that is wrong about
the file, and a budgeter that acts on the same wrong number.

### C3 · The studio cannot embed a font, and the checkbox that says it did changes nothing

`src/ui/services.js:843-847`, `src/ui/actions.js:478-485`, `src/emit/emit.js:106`.

§7: *"`embeddable` is false unless the user explicitly supplies a font file they
assert they have rights to."* §13: *"Inline everything: … fonts (only
user-supplied, license-asserted)."* The emitter is ready — `deps.fonts` at
`emit.js:66`, `compileFontFaces` at `:106`. The studio never passes it:

```js
// src/ui/services.js:843
return await emitLane.emit(proof, normalizeEmitOptions(options), {
  runtimeJs: env.runtimeJs || '',
  runtimeCss: env.runtimeCss || '',
  clock,
});                                    // no `fonts`, no `themeCss`
```

There is no action anywhere in the 140-action registry that accepts a font file.
`brand.extractFiles` routes to `importFiles` (ingest captures), not to a font
store. So `FONT_UNAVAILABLE` — whose own message tells the user to *"supply a
licensed font file to embed"* — names a remedy the product does not offer.

Worse, the one control that exists is `brand.setFaceEmbeddable`, a checkbox
labelled "Assert a font licence". Ticking it with no file (`91`-series probe):

```
FONT_UNAVAILABLE before: 2   after: 0
emit ok:  true
@font-face in the artifact:  false
"Sohne" still in the artifact's font stack:  true
```

The seller asserts a licence for a file they were never asked for, both warnings
disappear, and the artifact still ships with `font-family: Sohne, Arial, …` and
no `@font-face` — so the client's machine renders Arial. A checkbox that changes
a claim without changing a fact is the one thing §18 exists to prevent.

### C4 · A project file with no proof in it imports cleanly

`src/core/storage.js:486` (`importProjectJson`).

The function checks the format banner and calls `migrateRecord`. It never calls
`validateProofShape`, which is exported from `src/core/contracts.js` and which the
emitter uses. Ten hostile files (`12-project-io.mjs`):

```
ACCEPTED   proof missing entirely           | validateProofShape: "proof: must be an object"
ACCEPTED   proof is null                    | validateProofShape: "proof: must be an object"
ACCEPTED   proof.spine is a string          | validateProofShape: "proof.spine: must be an array"
ACCEPTED   proof.brand removed              | validateProofShape: "proof.brand: must be an object"
ACCEPTED   proof.schemaVersion 99           | validateProofShape: "proof.schemaVersion: must be 1"
ACCEPTED   duplicate branch ids             | (see C5)
ACCEPTED   duplicate specimen ids
ACCEPTED   contentHash tampered
rejected   record schemaVersion 2 (future)
```

`project.import` (`src/ui/actions.js:301`) hands the result straight to
`loadRecord`, which resets the command stack — so an unreadable file replaces the
open project and takes the undo history with it. §16 makes this file the way a
project *"moves between machines and can be committed to a repo"*: it will be
merged, hand-edited and truncated. The round trip itself is clean — I verified
`exportProjectJson` → `importProjectJson` is byte-identical on the 279 kB corpus
project, hash preserved — so the only gap is the missing guard.

### C5 · Two branches with the same id silently become one

`src/runtime/deck.js:56` (`sequences.set(branch.id, …)` in a loop over
`proof.branches`), `src/validate/rules.js:288-300`.

Nothing dedupes branch ids. The second `set` overwrites the first, one whole
objection branch disappears from the deck, and no `DUPLICATE_*` finding fires.
What the seller is told instead (`10-orphan-detail.mjs`, branches[1].id set to
branches[0].id):

```
2:ASSET_MISSING  Scene sc_d3f4d1f8e14f anchors branch "bn_0c0a82c55c49",
                 which is not in the proof.
```

`bn_0c0a82c55c49` **is** in the proof — it is the id that got overwritten. The
message sends the user looking for a branch that is sitting in front of them, and
the emit proceeds. Reachable through C4 (a hand-edited or merged project file),
which is the same door.

By contrast a duplicated *scene* id is handled properly: `DUPLICATE_SCENE` at
severity 1, emit refused, both for spine-vs-branch and branch-vs-branch
collisions. The branch case is the hole.

### C6 · The first reload of a new project loses it from the studio

`src/ui/app.js:388` and `src/ui/app.js:552`.

`start()` restores the last project from a `studio.lastProject` setting. That
setting is written in exactly one place — `loadRecord`, at `:388` — which runs
when you **open** or **import** an existing project. Creating a project and
saving it never writes it.

Measured in a persistent Chromium profile (`40-persist.mjs`): name the prospect,
extract the brand, capture a specimen, `Ctrl+S` → "Saved 19 Aug 2026, 03:09".
Reload:

```
project name after reload:  "Untitled proof"
prospect after reload:      ""
rail:                       Brand —, Specimens —, everything blank
```

Nothing is lost: the record is in IndexedDB, it appears in the project list as
`CRITIC PERSISTENCE TEST · Northwind Industrial · rev 3 · 36.4 kB`, and opening
it restores brand and specimens intact. A **second** reload then restores
automatically, because opening it finally wrote `lastProject`. So the studio
forgets exactly one project: the one you are building right now, on the reload
you did not plan. §20.10 asks for "every place the flow … loses work"; this is a
seller who refreshes and sees an empty studio thirty minutes before a pitch.

### C7 · The artifact never wears the brand theme the studio previewed

`src/ui/services.js:843-847` (no `themeCss`), `src/ui/preview.js:180-183`
(preview uses `compileTheme(brand).css`), `src/emit/emit.js:103-105` (falls back
to `compileFallbackTheme`).

The studio's own inspector says "23 variables compiled for the artifact
stylesheet" — and then does not pass them. Every emit falls through to
`compileFallbackTheme(proof.brand)`. Diffed on the corpus brand
(`15-theme-diff.mjs`):

```
compileTheme (studio preview): 863 bytes   compileFallbackTheme (every emit): 780 bytes
19 of 23 custom properties identical; 4 differ:
  --pp-scale          preview 1                                    artifact (absent)
  --pp-stage-pad      preview clamp(20px, 3.2vw, 56px)             artifact (absent)
  --pp-transition-ms  preview 200ms                                artifact (absent)
  --pp-shadow         preview 0 1px 2px rgba(12,15,20,.08), …      artifact 0 1px 2px rgba(0,0,0,0.08)
```

All the colour and type roles agree, so this is not a visual disaster — but stage
padding, transition duration and shadow are what the studio shows at "true
aspect" per §15 and are not what the artifact gets, and `compileFallbackTheme` is
by its own name the path for when L5 is absent. L5 is present.

### C8 · The `ar-SA` locale rendition is thrown away by the renderer

`src/recipe/locales.js:161` (`dir: 'rtl'`), `src/scene/blocks.js:173-177`.

§9.1 asks `locale-fanout` for *"locale-appropriate structure, not just translated
strings"*. The recipe does the right thing — the ar-SA rendition's body arrives as
correctly-marked blocks (`71-rtl.mjs`):

```
{"type":"raw","html":"<h1 dir=\"rtl\" lang=\"ar-SA\">Designing fouling margin you will actually use</h1>"}
{"type":"raw","html":"<p dir=\"rtl\" lang=\"ar-SA\">The fouling factor is …</p>"}
```

They are `raw` blocks, and every layout flattens a `raw` block to plain text
under a fixed caption:

```js
// src/scene/blocks.js:173
case 'raw':
  // §8: raw source is never presented as markup by a layout.
  return h('div', { class: 'pp-raw' },
    h('p', { class: 'pp-raw-label', … }, 'Source markup, shown as text'),
    h('p', { class: 'pp-raw-text',  … }, stripTags(block.html)));
```

Emitted and checked (`72-rtl-render.mjs`):

```
emit ok: true
dir="rtl" anywhere in the artifact:            false
"Source markup, shown as text" in the artifact: true
```

`grep -rn "rtl\|direction" src/scene src/runtime src/emit` returns nothing but
`flex-direction`. So the Arabic-market rendition renders left-to-right, labelled
as if it were the prospect's own page source rather than the recipe's output. The
structural facts survive only as a table row reading "Writing direction · right to
left" — the recipe *describing* the difference in place of the deck *showing* it,
which is the distinction §9.1 draws.

Two rules collide here and one of them wins wrongly: §8's "never present raw HTML
without a per-specimen opt-in" is about *captured source*, and the recipe's own
output is not captured source.

---

## Severity 3

### C9 · Two ways to make the provenance label unreadable without triggering the emitter

`src/emit/provenance.js:286-332` (`judgeLabelStyle`).

§18.1: the label "cannot be styled to invisibility (contrast and size floors
enforced at emit)". I threw 18 stylesheets at it through `deps.userCss` and
`deps.themeCss`, and measured each survivor's label in Chromium
(`14-label-style.mjs`, `16-label-visual.mjs`). Thirteen were refused — including
`display:none`, `visibility:hidden`, `opacity:0`, `font-size:2px`, `font-size:0`,
`clip-path:inset(100%)`, `transform:scale(0)`, `text-indent:-9999px`, a fixed
off-screen position, `color:rgba(0,0,0,0)`, and colour-equals-background — and
correctly through **both** `userCss` and `themeCss`. Two got through:

```
.pp-provenance{height:1px!important;overflow:hidden!important}
   → label box 313.1 × 22.2  becomes  313.1 × 6.0   (content beside it fully visible)
.pp-provenance{letter-spacing:-1em!important}
   → label box 313.1 × 22.2  becomes   19.0 × 22.2  (an unreadable smear)
```

`judgeLabelStyle` checks `width|height|max-width|max-height` only against the
literal value `0` (`:293-297`) and does not model `letter-spacing` at all.

I am filing this at severity 3, not 1, because **no product path reaches it**:
`grep -rn "userCss" src/` outside `src/emit` returns nothing, `themeCss` appears
only in `src/ui/preview.js` for the live preview, and `services.emit` passes
neither. It is a hole in a lane API that only a future caller can fall into.

### C10 · A ghost branch anchor is reported as `ASSET_MISSING`

`src/validate/rules.js:294`. A scene anchoring a branch id that is not in the
proof produces `code: 'ASSET_MISSING'`. §4's `FindingCode` has
`BRANCH_UNREACHABLE` for branch topology; a rehearse panel or a caller filtering
`ASSET_MISSING` to find missing media gets branch-graph problems in the same
bucket. The finding itself is correct, well-worded and closes CRITIQUE-1's F20;
only the code is wrong.

### C11 · "Nothing blocks the emit", on a proof that cannot be emitted

`src/ui/panels/rehearse.js:156`, `src/ui/actions.js:1280`.

With zero scenes, the Rehearse panel (`studio-rehearse.png`) shows, all at once:

```
banner:     "Sweep clean across 2 checks."
sweep card: "No blocking findings. The emit is open once nothing else is outstanding."
            "Scenes walked  0"
Blocking·0: "Nothing blocks the emit."
status bar: "This proof has no spine. Add at least one scene before emitting."
```

The Emit panel on the next screen is correct and firm. But §14 makes rehearsal
"the last pass before you walk in", and the words *Nothing blocks the emit* are
false at the moment they are printed. A sweep that walked zero scenes is not
"clean"; it is vacuous, and the panel already knows the count.

### C12 · `--verify-repeat 3` does not repeat three times

`scripts/build.mjs:331`: `const verifyRepeat = args.has('--verify-repeat');` —
a boolean. The trailing `3` is ignored and the flag always builds exactly twice.
The output reads "3 output(s) byte-identical across two builds", where the 3 is
the file count, which is easy to read as three repeats. The determinism it does
prove is real (I confirmed byte-identity across five separate processes and three
timezones myself); the flag just does not take the argument the handoff uses.

### C13 · `dist/northwind-demo.pitchproof.html` is a committed artifact nothing builds

405,414 bytes, tracked, last touched by `cd08b11`. `scripts/build.mjs` does not
produce it, `verify-offline.mjs` does not read it, and no `.md` references it.
Everything else in `dist/` is regenerated by the build, so a hand-placed file
there reads as current output. It is not: it is 405 kB against the current
artifact's 597 kB. I opened it (`95-demo.mjs`) — 99 positions, 0 requests, 0
console errors, provenance labels present — so it works today and will rot
silently.

### C14 · `DEFERRED.md` still says no critic pass has been run

> "## Nothing deferred yet.
> No critic pass has been run."

CRITIQUE-1 ran and filed 24 findings. §21.4 makes this file the register that
turns a deferral into "a deliberate, reviewable act"; a register that denies the
pass happened cannot do that job.

### C15 · `MemoryBackend` reports a quota it never enforces

`src/core/storage.js:149-190`. With a 400 kB quota, eight saves of the corpus
project (`41-quota.mjs`):

```
save 1: ratio 0.899  level=warn      ok
save 2: ratio 1.348  level=critical  ok
…
save 7: ratio 3.596  level=critical  ok
```

The §16 pressure warning fires correctly at 0.8 and the listener receives every
event — that part is right. But `put` never refuses, so usage runs to 3.6× the
quota the same object reports. `MemoryBackend` is the degraded fallback when
IndexedDB is unavailable, so this is what a user in a locked-down browser gets.

### C16 · The network scanner does not see a base64-obfuscated API name

`src/emit/scan.js:109-127` (`JS_NETWORK_TOKENS`). 26 of my 27 planted references
were caught, including `window["fe"+"tch"]("htt"+"ps://evil.example/x")`. The
miss:

```js
new (window[atob("V2ViU29ja2V0")])(atob("d3NzOi8vZXZpbC5leGFtcGxlL3M="))
```

No token, no URL, nothing to match. I could not find a path to it: planted as a
`raw` ContentBlock (which is how a prospect's own obfuscated analytics would
arrive), the whole `<script>` is flattened to text before the scanner ever runs —
`08-raw-obf.mjs` confirms the base64 payload is absent from the emitted file. A
hardening note, not a live hole.

---

## Axis by axis

### 1. Contract fidelity — **PASS**

Machine-diffed the §4 code block in the spec against `src/core/contracts.d.ts`:

```
96 declared fields checked, 0 missing or renamed
FindingCode:  spec 14, current 14, 0 added, 0 removed
ColorRole:    14 / 14      SceneLayout:  8 / 8
Provenance:    3 / 3       SpecimenKind: 7 / 7
INTEGRATION_STRICT=1 node --test test/integration/api-conformance.test.mjs → 25 pass
```

`CONTRACTS-DISPUTES.md` carries 57 filed objections with the standing rule
"Every objection below was built against as written."

What would have caught this failing: I looked specifically for a widened
`FindingCode`, having seen `NO_SCENES` in the studio's emit panel. It is not a
finding code — `src/ui/gate.js:82` is a studio-local `Blocker.kind`, a different
type from `Finding.code`, and no `Blocker` ever reaches a `Finding[]`. That is
the right way to add a UI-level blocker without touching a frozen union.

### 2. Determinism — **PASS**, proven

`90-determinism.mjs`, five separate `node` processes:

```
7d245a6617e9d059dd417c8901b33a68f66002a24f35c493851a64f171fa291f  597217  TZ (unset)
7d245a6617e9d059dd417c8901b33a68f66002a24f35c493851a64f171fa291f  597217  TZ (unset)
7d245a6617e9d059dd417c8901b33a68f66002a24f35c493851a64f171fa291f  597217  TZ (unset)
7d245a6617e9d059dd417c8901b33a68f66002a24f35c493851a64f171fa291f  597217  TZ=Asia/Tokyo LANG=de_DE.UTF-8
7d245a6617e9d059dd417c8901b33a68f66002a24f35c493851a64f171fa291f  597217  TZ=America/Los_Angeles
```

Byte-identical across processes, timezones and locale. `lint-determinism.mjs`
clean; `build.mjs --verify-repeat` byte-identical on all three outputs. I looked
for the usual leaks — a timezone-dependent date format, a locale-dependent
`toLocaleString`, `Object.keys` ordering over a Map, an unseeded k-means init —
and moving TZ and LANG would have exposed the first two.

### 3. Colour correctness — **PASS**

Not taken from the suite. I wrote WCAG relative luminance from the specification
text and checked the corpus brand's solved roles against it (`91-colour.mjs`):

```
role          hex      pair        pairHex  claimed              independent  ≥4.5
onPrimary     #ffffff  primary     #071a2e  17.554956768204484   17.5550      yes
onSecondary   #ffffff  secondary   #0f2a47  14.558222204615276   14.5582      yes
onSurface     #071a2e  surface     #ffffff  17.554956768204484   17.5550      yes
onSurfaceAlt  #071a2e  surfaceAlt  #eef2f6  15.604722324507257   15.6047      yes
onAccent      #071a2e  accent      #e8622c   5.195100068678252    5.1951      yes
```

`#e8622c` is the corpus's deliberately awkward mid-orange: the solve refuses
white on it and puts the deep navy there instead, at 5.20:1. `contrastWithPair`
is computed, not assumed, and agrees with mine to five decimal places.

OKLab against Ottosson's published values, through the module's own `hexToOklab`:

```
#ffffff  Δ 3.73e-8    #ff0000  Δ 6.11e-8    #00ff00  Δ 7.42e-8    #0000ff  Δ 2.28e-6
WCAG worked examples: white/black 21.0000 · #767676 on white 4.5422 · #949494 on black 6.9228
```

`test/brand/color-reference.test.mjs` + `contrast-solve.test.mjs` = 72 tests,
all passing, with a named adversarial palette corpus, a raised-to-AAA variant, a
sweep of every floor from 1.5 to 4.5, a post-condition that rejects a hand-built
failing palette, and a proof that the search bound is admissible. There are no
eyeballed constants: `src/brand/oklab.js` exports `PUBLISHED_LMS_TO_XYZ`,
`PUBLISHED_OKLAB_TO_LMS` and `PUBLISHED_LMS_TO_LSRGB` and derives the inverses.

### 4. Offline integrity — **PASS**

I planted violations rather than reading about them.

**In the finished HTML — 26 of 27 caught** (`06-network-plants.mjs`). Every
attribute route, both CSS routes, every script route including
`window["fe"+"tch"]("htt"+"ps://…")`, `<base href>`, `ping`, `importmap`,
`srcset` with a protocol-relative candidate. The one miss is C16.

**Through the model — every route refused or provably neutralised**
(`07-model-plants.mjs`):

```
REFUSED(net)  raw block with tracking pixel        REFUSED(net)  raw block with plain script fetch
REFUSED(net)  media dataUri swapped for a URL      REFUSED(net)  logo svg with a foreign <image>
REFUSED(net)  branch scene raw block               REFUSED(net)  rendition raw block
REFUSED       logo data is a remote URL (ASSET_MISSING)
EMITTED       cta href to remote            → stripped, no leak
EMITTED       presenter note with markup    → stripped, no leak
EMITTED       og:image remote              → stripped, no leak
EMITTED       headline carrying <script>   → escaped to &lt;script&gt;, rendered as text
EMITTED       table cell with an <img> tag → escaped, rendered as text
```

The two "in the artifact" cases are the scanner's documented and correct policy:
a URL in a text node is not a reference, and both are HTML-escaped so no browser
resolves them.

**The real file.** The emitted corpus artifact loaded from `file://` in Chromium
with every non-`file://` request aborted: **1 request, the document itself**; zero
page errors; zero console errors; zero `fetch|XMLHttpRequest|WebSocket|sendBeacon|
localStorage|analytics|gtag` tokens anywhere in the 597 kB. Same over the
four-deep nested-branch artifact across 99 positions and every overlay.

### 5. Overflow detection efficacy — **FAIL**

See C1. The corpus plants pass cleanly — all nine `PLANTS` detected, zero
undeclared collateral, zero baseline findings lost (`50-plants.mjs`):

```
DETECTED  TEXT_OVERFLOW_CLIP   NETWORK_REFERENCE   CONTRAST_FAIL   BRANCH_NO_RETURN
          BRANCH_UNREACHABLE   ASSET_MISSING       BEAT_EMPTY      DUPLICATE_SCENE
CORRECT   CTA_LIVE_LINK_NEUTRALISED — a negative control (`expectsNothing`); the
          pipeline neutralises the live link before the detector sees it, and the
          detector correctly stays silent.
                                                   9/9, 0 undeclared collateral
```

That is a real improvement on CRITIQUE-1's F7 and it is what convinced me to go
looking for a harder oracle. Nine plants cannot measure a recall claim of 0.98,
and when the oracle is a browser instead of the engine's own geometry table the
number is 0.65.

One more structural note: every `TEXT_OVERFLOW` in the corpus deck lands at
severity 2, because `narrowIfSignalled` (`src/validate/overflow.js:396`) narrows
anything ellipsised, and every box in these layouts either sets
`text-overflow: ellipsis` or is `-webkit-line-clamp`ed (which draws its own
ellipsis regardless of `text-overflow`). The policy is defensible and documented.
The effect is that §22.2's check can never block an emit in practice, so its only
value is the accuracy of its warnings — which is what C1 is about.

### 6. Branch integrity — **PASS**, with C5

I built a four-deep nested chain by hand — spine → br0 → br1 → br2 → br3, each
branch scene anchoring the next — emitted it, and drove it with the keyboard
(`80/81/82-*.mjs`).

**Jump index.** Typing 8–12 characters of each objection found exactly one
result and landed in the right sequence, four times running.

**Return stack, all `anchor` policies:**

```
in: bn_5837b0fa7309 → bn_0c0a82c55c49 → bn_5924df65986a → bn_53d3e30e1cc0
Backspace → bn_5924df65986a      Backspace → bn_0c0a82c55c49
Backspace → bn_5837b0fa7309      Backspace → spine sc_aedb0357bcb3
Backspace → spine (rests)
```

Four frames, popped one at a time, terminating on the spine and staying there.
§22.4 is handled. With `returnPolicy: 'nextSpineScene'` in the chain the pop
lands on the spine and discards the frames below it, which is what that policy
says it does; the presenter is never stranded off-spine either way. `r` goes
straight to the spine from any depth, as §12 specifies.

**Orphans I constructed** (`09/10/11-*.mjs`, 17 cases). Every one either produced
a finding or was correct to produce none:

```
branch with zero scenes                          → 1:BRANCH_NO_RETURN, emit refused
branch scene id collides with a spine scene id   → 1:DUPLICATE_SCENE,  emit refused
branch scene reuses another branch's scene id    → 1:DUPLICATE_SCENE,  emit refused
no anchor, no jump entry (objection emptied)     → 2:BRANCH_UNREACHABLE + 2:BRANCH_NO_RETURN
no anchor anywhere (objection intact)            → 2:BRANCH_NO_RETURN   [correct: §11 requires
                                                    no anchor AND no jump entry for UNREACHABLE]
anchor names a branch that does not exist        → 2:ASSET_MISSING      [C10: wrong code]
anchors form a cycle                             → 2:BRANCH_NO_RETURN
two branches share an id                         → C5
```

### 7. Provenance enforcement — **PASS**, with C9

Thirty routes to unlabelled illustrative content. All refused at the emitter:

```
refused  labelIllustrativeContent:false passed to emit()          1 × PROVENANCE_UNLABELED
refused  labelIllustrativeContent:false in proof.emitOptions      1 × PROVENANCE_UNLABELED
refused  mode:'review' + label off                                1 × PROVENANCE_UNLABELED
refused  all 31 renditions forged to 'verified-by-user'          65 × PROVENANCE_UNLABELED
refused  forged 'verified-by-user' + a hand-built promotion record with a 64-hex digest
refused  provenance set to an unknown string      → §4 contract violation, refused earlier
refused  13 of 18 stylesheet attacks on the label, through userCss AND themeCss
```

The forged-promotion case is the one that matters: a hand-written
`{by, at, digest}` on every rendition does not promote anything, because the
digest is checked against the rendition's own content.

Adapter secrets (`36-adapter-secret.mjs`): an endpoint that echoes the API key
back inside its generated copy is refused by `runAdapter` itself —
`"refusing a rendition that carries adapter configuration — rendition.blocks[0].text:
embeds a configured adapter key"` — before the rendition can reach a proof.

C9 is filed at severity 3 because the two surviving attacks need `deps.userCss`
or `deps.themeCss`, and no path in the studio supplies either. In the emitted
corpus artifact I measured the label in Chromium: `313.1 × 22.2` px, `font-size:
12px` against an 11px floor, `display: flex`, `opacity: 1`, `visibility: visible`,
not covered by anything.

### 8. Presentation robustness — **PASS**

Driven by me, on the real file, in Chromium, network off.

```
spine walk                  99 positions across 31 scenes, 0 console errors, 0 page errors
back-navigation             98 forward-then-back round trips, 0 state-hash mismatches
blank screen (b)            enters, and b again restores the exact prior hash
overlays                    m → pp-overlay--map (with nested anchor rows)
                            c → pp-overlay--contents (31 items, current + seen marked)
                            ? → pp-overlay--help (3 groups, generated from the binding table)
                            / → pp-overlay--jump (live result count, active row)
                            Escape closes each
nested jumps                4 deep, then 4 Backspace pops, terminating on the spine
network                     0 requests attempted
```

The state-hash comparison is mine, taken from `.pp-stage[data-pp-hash]` before
and after each `ArrowRight` / `ArrowLeft` pair, not from the runtime's own
simulation. Zero divergence over 98 pairs.

The one thing I would change is not a defect: beat 0 of most scenes is a headline
over an empty frame (`scenes/s05-sc_cd73819f5077-b0.png` is a title and 800px of
white), because reveals are additive from nothing. That is §10 working as
specified; it just means a presenter's first keypress on every scene is a
formality.

### 9. Degradation honesty — **FAIL**

See C2. What is right: every degradation is a line item with `from`, `to`,
`reason`, `steps`, `predictedBytes` and `actualBytes`, and prediction tracks
reality per-asset within about 10%. The plan is monotonic in rank. Nothing is
silent. What is wrong is the total, the trigger and the stopping point, all from
one bad reserve.

### 10. Studio usability under pressure — **PASS**, with findings

I assembled a proof from the fixture corpus end to end in
`dist/pitchproof-studio.html` — the built file, from `file://`, with the corpus
origin fulfilled from the fixture directory and every other request aborted.

```
Alt+1  prospect typed
Alt+2  URL pasted, Enter
       → served: / · /robots.txt · /assets/site.css · /assets/mark.svg
                 /assets/hero-plant.png · /assets/logo.svg · 3 × sohne-*.woff2 (404)
       → Colours 14  Faces 2  Logos 2  ·  4 groups held below the 70% confidence floor
       → "I have checked all of these"
Alt+3  four URLs, Enter each → 4 specimens
Alt+4  Load the seed library → 9 recipes ·  Run all → 29 renditions
Alt+5  Add a scene… → 8 scenes across all eight layouts
Alt+6  three objections typed → 3 branches
Alt+7  Alt+R → "Sweep clean across 10 checks · Blocking 0 · Warning 15"
Alt+8  Ctrl+Enter → 383 kB, 0 degradations, deflate, "Last emitted 19 Aug 2026, 03:03"
```

CRITIQUE-1's F1 is comprehensively closed: the studio fetches sub-resources and
the brand engine is fed. So are F14 (the seed library runs from the panel) and
F15 (the review gate needs the checkbox, and says which four groups and why).

Frictions, in order of how much they would cost under time pressure:

1. **C6** — a reload of a brand-new project opens an empty studio.
2. **C3** — no way to supply the licensed font the findings tell you to supply.
3. **C11** — the rehearse panel says "Nothing blocks the emit" when it does.
4. **Mouse-only where a key would do.** "Add a scene…" is a `<select>`, driven
   eight times to build the spine; `brand.reviewAll`, `recipe.loadSeed`,
   `recipe.runAll` and `branch.create` are buttons with no binding, six presses
   between them. All are reachable by Tab and every one of them is a real
   control rather than a hidden one, but `Mod+K` reaches only 44 of the 140
   registered actions — the other 96 are declared `palette: false` — so the
   command palette is not a keyboard escape hatch for the assembly steps.
5. **Auto-fix.** Three offered ("Auto-fix: Anchor branch X to the opening scene
   sc_…"), each labelled "Applied through the command stack, so one undo takes it
   back", and a Revert control beside them. The applied fix does not update the
   warning count until you re-sweep — the status bar says so ("The proof has
   changed since the last sweep"), which is honest but means the fix looks like
   it did nothing.
6. **Dry run (`Alt+D`)** works: a heads-up bar reading `DRY RUN 1/11 · 14 findings
   across the deck` with Back / Next / End, driving the live preview. The count
   is 14 where the sweep says 15. I did not chase the off-by-one; it is not
   worth a finding, but two numbers on two panels for the same sweep is a small
   tax on trust.

The chrome itself is strong. §15's palette is exactly right, the "Next — what the
definition of done still wants (§1.2)" checklist in the inspector is the single
best affordance in the product, and `emitBlockers` gives a precise, non-negotiable
list of what stands in the way with a "Go to Scenes" jump on each.

### 11. Non-goal violations — **PASS**

```
artifact:  0 × fetch(  0 × XMLHttpRequest  0 × WebSocket  0 × sendBeacon
           0 × localStorage  0 × analytics  0 × gtag  0 × navigator.send
studio:    every absolute URL is a .example placeholder or a W3C namespace
           http://www.w3.org · https://example.com · https://proxy.yourcompany.example
           https://www.example.com · https://www.northwind.example · https://your-endpoint.example
src/:      0 matches for roi|forecast|projected savings|estimated value|payback
```

No account system, no sync, no server. The optional §9 adapter is the only
network path in the studio, is empty by default, is called only when the user
configures an endpoint, stamps every result `provenance: 'illustrative'`
(verified end to end in `35-proxy-adapter.mjs`), keeps its key out of the
artifact, and refuses a rendition that echoes the key back. The CORS proxy is
empty by default and, once set, routes every sub-resource through it — I watched
all ten requests and only the first direct attempt bypassed it, which is strategy
1 failing before strategy 2 runs.

---

## What is genuinely strong

Worth stating plainly so a fix pass does not damage it.

- **Ingest, all of it.** I drove every §6 strategy against the corpus and graded
  each on what the brand engine actually receives:

  ```
  ingestUrl    assets 4  sheets 1  cssBytes 3072  colours 14  confidence 0.60
  HAR          assets 3  sheets 1  cssBytes 3072  colours 14  confidence 0.60
  MHTML        assets 2  sheets 1  cssBytes 3074  colours 14  confidence 0.60
  SAVED PAGE   assets 3  sheets 1  cssBytes 3072  colours 14  confidence 0.60
  CORS PROXY   assets 4  strategy=cors-proxy, 9 of 10 requests through the proxy
  ```

  `.har`, `.mhtml` and saved-page were untested ground after pass 1. They are not
  stubs: quoted-printable decoding, base64 parts, `Snapshot-Content-Location`,
  the `_files/` sibling directory convention, and asset relinking all work, and
  all three land the *same* brand as a live fetch. `.pptx` (3 slides → 7 blocks,
  media resolved), `.docx` (12 blocks) and `.pdf` (7 blocks, 2 page rasters) all
  reach a `Specimen` with their media refs rewired — CRITIQUE-1's F4, closed.

- **The runtime.** 98 forward-then-back round trips with zero state divergence,
  an exact blank-screen restore, four working overlays, a jump index that finds
  a branch from eight characters, and a return stack that unwinds four nested
  frames one at a time. This is the part of the product that has to work while
  someone is talking, and it does.

- **Provenance at the emitter, and adapter secret hygiene.** Thirty routes, all
  closed, including a forged promotion record and a live key echoed back by a
  hostile endpoint.

- **The network scanner.** 26 of 27 in the document, 13 of 13 through the model,
  with correct treatment of escaped text and inert literals — and the raw-block
  path flattens markup to text before the scanner even runs, which closes the
  one route a prospect's own page could have used to smuggle something in.

- **The colour engine.** Exact to published values, solved rather than guessed,
  tested against hostile palettes, and — new since pass 1 — actually fed.

- **The finding messages.** They are the best prose in the codebase. A single
  `TEXT_OVERFLOW` tells you the box, the overage in px and per cent, the text,
  whether the viewer will see an ellipsis, which face substituted for which and
  that the measurement is the fallback's own, and what size or character count
  would fit. That is what a warning should look like.

- **The disputes register.** 57 filed objections, every one built against as
  written.

---

## What I did not exercise

Stated plainly, because a critique that overclaims is worse than one with gaps.

- **A second browser engine.** `/opt/pw-browsers` holds only Chromium. Every
  measurement in this report — including the C1 ground truth — is Chromium's.
  A different engine could move the overflow numbers in either direction; it
  would not change the fact that the model gives `headline` 350px where the
  layout gives it 131px.
- **`prefers-reduced-motion` and the §10 motion budget.** I did not measure
  transition durations or interrupt an animation mid-flight.
- **Presenter view as a second window.** `p` opened no overlay, correctly,
  because it opens a window; I did not drive the second window, its next-beat
  preview, or the manual timer.
- **The cold-boot budget on real hardware.** `verify-offline.mjs` measures 100ms
  FCP in a headless container against a 1500ms budget; a mid-range laptop opening
  a 25 MB artifact from a USB stick is a different measurement, and §13's "opens
  from a USB stick, from an email attachment" was not tested at all.
- **Precision of the overflow detector.** I measured recall against a browser,
  not precision. Preflight reported eight boxes my walk did not see; five are in
  branch scenes my spine-only walk never entered, but three
  (`sc_28aa5e626746`, `sc_5ee8ce9de980`, `sc_b318c3847f7d`, all `stepLabel` at
  `sm`) are on the spine and may be genuine false positives. Three out of 70 is
  not a precision problem worth filing, but I did not chase them, so I have no
  honest precision figure.
- **`emit.download` / `emit.verify` in the studio.** I confirmed the artifact was
  produced (383 kB, 0 degradations, "Last emitted …") but did not drive the Save
  or Verify buttons to a file on disk.
- **The `restore` / chrome-stripping reversal controls**, `specimen.rawOptIn`
  through the UI, and block-level editing. CRITIQUE-1 measured chrome stripping
  and found it excellent; I took that on trust and did not re-measure F1 scores.
- **Migration.** `MIGRATIONS` is empty by construction at `schemaVersion: 1`, so
  there is no forward path to test yet; I only confirmed a future-versioned
  record is refused.
- **Whether the corpus fixture's own copy is good.** Several scenes waste most of
  the frame (`last/l05` puts three nodes in the right two-thirds and leaves the
  left half empty; the quoteCard sits low-left). That is layout composition
  rather than correctness, and I did not judge it as a finding.

---

## Reproducing this

```sh
S=/tmp/claude-0/-home-user-PitchProof/4f4867db-5fdf-5b7b-bf15-0e36c8d8a775/scratchpad/c2
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

node $S/01-emit.mjs                # the corpus through the pipeline to an artifact
node $S/03-sweep.mjs               # 99 positions, per-element clipping, 31 screenshots
node $S/52-overflow-detail.mjs     # C1 — the ground-truth comparison, recall 0.59
node $S/53-shots.mjs               # C1 — screenshots of three unreported truncations
node $S/62-reserve.mjs             # C2 — the reserve double-count, in bytes
node $S/60-degrade.mjs             # C2 — reported vs actual savings at five budgets
node $S/06-network-plants.mjs      # 27 planted network references
node $S/07-model-plants.mjs        # 13 planted through the model
node $S/09-orphans.mjs             # 11 branch orphans
node $S/10-orphan-detail.mjs       # C5 — duplicate branch ids
node $S/12-project-io.mjs          # C4 — 10 hostile project files
node $S/13-provenance.mjs          # 12 routes to unlabelled illustrative content
node $S/14-label-style.mjs         # C9 — 18 stylesheet attacks on the label
node $S/33-ingest4.mjs             # every §6 strategy, graded on brand yield
node $S/35-proxy-adapter.mjs       # CORS proxy + runtime adapter
node $S/36-adapter-secret.mjs      # an endpoint that echoes the API key back
node $S/50-plants.mjs              # all nine PLANTS, 9/9
node $S/72-rtl-render.mjs          # C8 — dir="rtl" never reaches the artifact
node $S/91-colour.mjs              # independent WCAG + OKLab reference check
node $S/24-studio-emit2.mjs        # the whole §1.2 flow in the built studio
node $S/40-persist.mjs             # C6 — reload before and after an explicit open
node $S/70-dryrun.mjs              # auto-fix buttons and Alt+D
node $S/81-drive.mjs               # nested jumps, blank, overlays, back-nav
for i in 1 2 3; do node $S/90-determinism.mjs; done
```

Two notes on the working tree. Running `scripts/build.mjs --verify-repeat`
rewrites `dist/` — the three built outputs came back byte-for-byte identical to
the committed ones, so nothing drifted, but a critic's run is not read-only.
And `dist/northwind-demo.pitchproof.html` (C13) is untouched by it either way,
which is the finding.

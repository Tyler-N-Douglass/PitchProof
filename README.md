# PitchProof

**Compile a prospect's own content and brand into a self-contained, offline, branchable proof.**

A generic demo dies to one objection: *"our situation is different."* PitchProof
removes the surface that objection lands on. It ingests a prospect's public web
presence and supplied materials, extracts their brand system, captures real
content specimens, stages before/after scenes against those specimens, wires
objection branches, validates the whole thing in rehearsal, and emits a single
HTML file you can present live and then hand to the room.

Two artifacts come out of this repository:

- **`dist/pitchproof-studio.html`** — the studio. One file, deployable to any
  static host, no build server. This is what a seller opens the day before a
  pitch.
- **`*.pitchproof.html`** — the proof artifacts the studio emits. Each opens with
  no network, no login and no dependencies, from a local file, a USB stick, or an
  email attachment saved to a desktop.

---

## What it will not do

These are product laws, enforced in code, not preferences:

1. **No telemetry, view tracking, analytics, pixels or phone-home of any kind in
   an emitted artifact.** The emitter parses the final document and refuses to
   write it if anything could reach the network; CI then loads the artifact in a
   headless browser with every request blocked and fails on a single attempt.
2. **No live generation during a presentation.** An artifact contains only
   pre-baked content.
3. **No CMS, DAM or platform integrations.** Ingest is the public web plus local
   files.
4. **No forecasting, scoring, ROI calculators or measurement dashboards.**
   PitchProof produces and presents; it does not estimate.
5. **No accounts, no cloud, no backend.** Everything runs in your browser against
   local storage.

And two honesty laws that shape the whole design:

- **Illustrative content is always labelled**, the label cannot be styled to
  invisibility, and the rule is enforced in the emit path rather than the UI. The
  tool must never help someone imply that generated sample content is the
  client's approved copy.
- **Nothing fabricates facts.** There is no sample-stat generator, no invented
  testimonial, no third-party logo. A recipe renders what the source specimen
  contains and invents nothing.

---

## Using it

Open `dist/pitchproof-studio.html`. The left rail is the order of work:

**Project → Brand → Specimens → Recipes → Scenes → Branches → Rehearse → Emit**

1. **Brand** — paste the prospect's URL, or drop a saved page, a `.har`, a
   `.docx`, a `.pptx`, a PDF or images. Colour roles are solved, not guessed: the
   assignment is an optimisation over contrast, chroma, lightness ordering and
   hue separation, and any `onX` role that cannot reach 4.5:1 from the extracted
   palette is derived in OKLCH until it can. Type families get a
   metric-compatible fallback stack and a measured `metricDelta`, because font
   substitution is what breaks reskinned layouts and it breaks silently.
2. **Specimens** — captured pages are stripped of chrome by four independent
   signals, and every stripped block is retained with its reason so you can put
   it back.
3. **Recipes** — eight seed transformations, and a side-by-side paste surface
   with block-level alignment for the outputs you already have. Every rendition
   carries provenance.
4. **Scenes and Branches** — assemble the spine from eight layouts, then attach
   objection branches in the client's own words. Return is guaranteed: every
   branch exits to its anchor or the next spine scene, and nested jumps unwind
   correctly.
5. **Rehearse** — an automated sweep walks every beat of every scene and branch
   and reports findings; dry-run mode puts you through the whole deck with a
   heads-up issue counter. Severity-1 findings block the emit, and there is no
   override.
6. **Emit** — one HTML file, with every degradation the size budget applied
   reported as a line item.

### Presenting

`→`/`space` next beat · `←` previous · `↓`/`↑` scene · `/` jump to an objection ·
`m` branch map · `b` blank the screen · `r` return to the spine · `p` presenter
view · `Home`/`End` first/last scene · `?` keys · `Esc` close.

Nothing auto-advances, ever. A proof that moves on its own in front of a client
is a defect.

---

## Building from source

Node 22. Zero runtime dependencies; Playwright is the only dev dependency and is
used solely by the offline verifier and the browser cross-checks.

```sh
npm install
node scripts/build.mjs            # writes dist/
npm test                          # the full suite
node scripts/verify-offline.mjs   # headless, network blocked, keyboard walk, boot budget
```

The full gate, which is what CI runs:

```sh
node scripts/lint-determinism.mjs       # no unseeded randomness or clock reads in src/
npm test
node scripts/build.mjs --verify-repeat  # two builds, byte-identical
node scripts/verify-offline.mjs
```

### Determinism

Every id comes from a seeded PCG32 substream or a content hash. `Math.random`,
`Date.now` and `new Date()` are banned inside `src/` and the ban is enforced by
`scripts/lint-determinism.mjs`; a line may use one only if it carries an explicit
`// determinism-quarantine: <reason>` marker. The same project emits a
byte-identical artifact twice, and a test asserts it.

---

## Layout

```
src/ingest      fetch strategies, HTML parsing, saved-page/HAR/MHTML, OOXML, PDF, sitemap
src/brand       colour science and role solving, type/logo/shape/imagery, theme compile
src/specimen    chrome stripping, block normalisation, media inlining, locale detection
src/recipe      the recipe library, paste alignment, the optional adapter, provenance
src/scene       eight layouts, the reveal system, the measurement surface
src/branch      branch graph, jump index, return logic, branch map
src/runtime     the presentation runtime, shared by the studio preview and the artifact
src/emit        inliner, size budgeting, compression, the network-reference scanner
src/validate    the preflight rules engine, overflow measurement, auto-fix, dry run
src/ui          the studio shell, rail, canvas and inspector
src/core        contracts, ids, storage, and the deterministic utilities everything shares
```

`PITCHPROOF-BUILD-SPEC-v1.0.md` is the specification and is authoritative.
`API.md` is the frozen integration surface between modules. `PLAN.md` records how
the work was decomposed, `DECISIONS.md` every judgment call the spec left open
and why it went the way it did, `CONTRACTS-DISPUTES.md` objections filed against
frozen contracts, and `DEFERRED.md` anything knowingly not fixed.

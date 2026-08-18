# L12 Studio UI — disputes

Objections to a §4 contract, an `API.md` surface, or a shared script. Per the
process rule, **every one of these is built against as written**; nothing below
was worked around in `src/ui/**`.

---

## D-L12-1 — `scripts/build.mjs` corrupts the studio bundle (blocking, one-line fix)

**Severity: blocking. `dist/pitchproof-studio.html` does not run today.**

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

**Suggested resolution for the integrator:** declare one of
`specimen.sampleImages(assets)` or `brand.samplesFromAssets(assets)` in `API.md`
Part 3 and add one line to `brandParts` in `src/ui/services.js`.

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
already is in practice.

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

# L10 Emitter — disputes

Objections to a §4 contract or an `API.md` surface. Per §19 and the lane brief,
**every one of these is built against as written anyway**, and every one is
implemented and tested in the form the contract specifies. Nothing here is a
deviation; it is a record of where the emitter had to do extra work to satisfy a
frozen surface, so the next revision of the contract has the evidence.

Cross-referenced into `CONTRACTS-DISPUTES.md` is the integrator's call; this
file is the lane's record.

---

## L10-D1 — §18.1's "always" and §9's "cannot be disabled for Review-mode builds" disagree

**The contract.** §18.1, Honesty Laws: "Illustrative content is **always**
labeled in the artifact and the label cannot be styled to invisibility." §9,
Provenance law: a rendition that is not client-supplied or promoted "renders
with a visible, non-removable label in the artifact **when
`labelIllustrativeContent` is true** — and it is true by default and **cannot be
disabled for Review-mode builds**."

**The objection.** Read together, §9 grants exactly what §18.1 forbids: for a
build with `mode: 'presenter'`, §9's sentence structure permits
`labelIllustrativeContent: false`, and §18.1 says labelling is unconditional.
The two cannot both be followed. Worse, the distinction does not survive
contact with how a file moves: a presenter-mode artifact is still a single
`.html` file on a laptop, and the same laptop forwards it. §13 anticipates
exactly that — "opens correctly from `file://`, from a USB stick, and from an
email attachment saved to a desktop". A proof that is honest in the room and
unlabelled in the inbox is the §22.6 failure with a delay on it.

**Built as written.** The emitter follows §9, the more specific rule.
`normalizeEmitOptions` (L1) forces the flag true for `mode: 'review'` and
`mode: 'both'`, and `emit()` additionally *refuses* an explicit `false` on those
builds rather than silently overriding it (decision E10). For
`mode: 'presenter'` the flag may be disabled, and then no label is demanded.

**What we would propose instead.** Delete the conditional from §9 and let §18.1
stand: the label is unconditional, and `labelIllustrativeContent` becomes a
setting that can only ever be true. That is one fewer state in the product, one
fewer branch in the emitter, and it removes the only path by which an unlabelled
illustrative rendition can legally leave the studio.

---

## L10-D2 — `TypeFace.embeddable` has nowhere to carry a font

**The contract.** §4, `TypeFace`:

```ts
embeddable: boolean;  // true only if a license-clear webfont file was supplied by the user
```

§13 then requires the emitter to inline "fonts (only user-supplied,
license-asserted)".

**The objection.** `TypeFace` carries no font bytes and no reference to any.
There is no `dataUri`, no asset id, no pointer into `MediaRef[]`. `embeddable`
can therefore be `true` while the emitter has nothing to embed, and no lane can
hand a font to the emitter through the frozen model at all. The field is a claim
with no payload behind it — the same shape of problem §9 identifies for
`verified-by-user`, and the emitter is the place both are supposed to be caught.

**Built as written.** `TypeFace.embeddable` is read but cannot be acted on. The
emitter accepts fonts through `deps.fonts` instead —
`{family, dataUri, weight?, style?, licenseAsserted?}` — and emits an
`@font-face` rule only for entries with `licenseAsserted === true` and a `data:`
URI. A face nobody asserted a licence for is never embedded, and the emitter
never fetches one, which is what §7 and §13 actually protect.
`test/emit/emit.test.mjs` asserts both directions.

**What we would propose instead.** Add one optional field to `TypeFace` —
`source: {dataUri: string, licenseAssertedBy: string, licenseAssertedAt: string} | null`
— mirroring the promotion record: a claim plus who made it and when. §4 permits
extension with optional fields, so this is additive rather than a break, and it
would let `embeddable` mean something a machine can check.

---

## L10-D3 — `Finding.locus` cannot name a place in a file

**The contract.** §4:

```ts
locus: { sceneId?: string; branchId?: string; specimenId?: string; assetId?: string };
```

**The objection.** The network scanner's whole job is to point at a byte. A
finding that says "this artifact contains a network reference" and cannot say
*where* is a finding a person then has to search a 600KB file for. §20 axis 4
has the critic planting a violation and confirming the build fails; confirming
*which* violation was caught needs a locus with a line in it.

**Built as written.** The declared fields are used exactly as declared. §4
permits extension with optional fields, so the scanner adds `line`, `column`,
`excerpt`, `where`, `element` and `attribute`; the provenance checker adds
`renditionId`, `check`, and the computed `contrast`, `fontSizePx`, `foreground`,
`background`, `opacity`. `test/emit/scanner.test.mjs` asserts every planted
violation reports the line it is on.

**What we would propose instead.** Promote the additions to the contract:
`locus: { …; renditionId?: string; line?: number; column?: number; excerpt?: string }`.
They are already what every lane will reach for.

---

## L10-D4 — `EmitResult` has no field for what was *not* degraded

**The contract.** API.md:

```ts
type EmitResult = { html; bytes; findings; degradations: DegradationLine[]; compression };
```

**The objection.** §13 requires the emitter to "report exactly what was degraded
and by how much — never silently", and `DegradationLine[]` covers that. It does
not cover the other half of an honest report: the assets that *could not* be
degraded and therefore kept the artifact over budget. Those are the ones the
user has to act on, and they are precisely what is missing when a
`SIZE_BUDGET_EXCEEDED` refusal is unhelpful.

**Built as written.** `EmitResult` carries every declared field with the
declared meaning. The emitter adds `undegradable: {assetId, bytes, reason}[]`
and `measured: {mode, payloadBytes, bootBytes, totalBytes}[]` alongside them, and
names the first few undegradable assets in the `SIZE_BUDGET_EXCEEDED` message so
the information reaches the user even through a caller that ignores the extra
field.

**What we would propose instead.** Add both as optional fields to `EmitResult`.

---

## L10-D5 — D10's allowlist makes an outbound link in the prospect's own content a severity-1 refusal

**The contract.** D10: `src`/`href` values must be `data:`, a `#` fragment, or
`about:blank`; "everything else … is `NETWORK_REFERENCE`, severity 1, emit
blocked with no override."

**The objection.** `ContentBlock` includes `{ type: 'cta'; label: string; href:
string | null }`, and a captured page's call to action almost always has a real
`href`. Under D10, any layout that renders that CTA as a working link refuses
the emit — and the message a lane author sees is about the network law rather
than about a product decision nobody wrote down.

**Built as written, and we think D10 is right.** The emitter enforces it exactly
as stated, and `test/emit/scanner.test.mjs` plants a rendered CTA anchor and
asserts the refusal. The behaviour is correct on the merits: a live link in a
proof is a way to leave the deck mid-pitch, it fetches, and on a machine with
networking disabled it fails in front of the client. The dispute is not with the
rule but with where it is written down — it currently lives in a decision about
scanning, and it is really a rule about what a scene may render.

**What we would propose instead.** State it in §10 where layouts are specified:
a CTA renders as a styled, non-navigating element; its `href` is presenter
information, not a destination. Then the scanner is enforcing a stated product
rule rather than discovering one.

---

## L10-D6 — `mailto:` and `tel:` are refused, and probably should not be

**The contract.** D10's allowlist is `data:`, `#`, `about:blank`. Nothing else.

**The objection.** `mailto:` and `tel:` reach no network — a click hands the URL
to a local mail client or dialler. Refusing them is stricter than §1.1 requires,
and a proof whose closing scene shows the account team's address is a reasonable
thing to want.

**Built as written.** Both are `NETWORK_REFERENCE`, severity 1. The emitter does
not carve out an exception, because an allowlist with judgement calls in it is
an allowlist that grows.

**What we would propose instead.** Nothing, for now. The address can be rendered
as text, which is what a client copies anyway, and the cost of the strictness is
one line of markup. Recorded so the critic can see the choice was made rather
than missed.

---

## L10-D7 — the artifact composition root is unowned by any lane

**The contract.** §19 assigns `/src/runtime` to L2, the eight layouts to L8, the
branch overlays to L9, and the emitter to L10. API.md says L8 "registers all
eight with L2's registry" and L9 "registers `jump`, `map` and `contents` on
`runtime.overlays`".

**The objection.** Nobody owns the file that calls those two functions. `src/runtime/**`
cannot import `src/scene/**` or `src/branch/**` without inverting the
dependency, the emitter is handed `runtimeJs` as an opaque string, and the
result is a defect visible to no lane's own tests: the artifact paints its
opening beat correctly and then renders "Layout not registered" on the first
keypress.

**Resolved during the build, and noted here for the record.** The integrator
created `src/artifact.js` as the composition root, and `scripts/build.mjs`
bundles that rather than `src/runtime/index.js`. The emitter needed no change —
the global is still `PitchProofRuntime` and `boot` keeps its signature — and its
boot script calls `registerAllLayouts()` and `registerBranchOverlays()`
defensively, guarded, for a bundle that does not do it. `emit()` independently
refuses when a layout the proof uses is not registered (decision E18), and
`scripts/verify-offline.mjs` asserts no placeholder layout appears in the loaded
artifact.

**What we would propose instead.** Name the composition root in §5's source
layout and in §19's lane table, so the next build does not rediscover it.

---

## L10-D8 — `validate/lane-emit.js` makes the emit↔validate dependency a cycle

**The contract.** `API.md` Part 3 gives L10 `scanForNetworkReferences` and
`assertProvenance`, and gives L11 `runPreflight`. §9 and §13 put the network and
provenance laws in the emitter; §14 puts *every* severity-1 finding there too.

**The objection.** Those two sentences together require the emitter to run
L11's rules and require L11 to call L10's checkers, and the module graph cannot
have both. `src/validate/lane-emit.js` re-exports L10's two functions from
`../emit/index.js`, so any import from `src/emit/**` into `src/validate/**`
closes a loop the bundler refuses (D3):

```
emit/emit.js → validate/index.js → validate/preflight.js
             → validate/lane-emit.js → emit/index.js → emit/emit.js
```

The emitter therefore cannot call `runPreflight`, which is the obvious way to
satisfy §14.

**Built as written.** `src/emit/gate.js` imports `RULES` from
`src/validate/rules.js`, which is the half of L11 with no back-edge — it takes
the scanner and the provenance checker through `ctx.deps` rather than importing
them. The gate supplies L10's own, builds the context `runPreflight` builds, and
runs every rule. `test/emit/gate.test.mjs` asserts the gate and `runPreflight`
produce identical findings, so the seam costs no fidelity.

**What we would propose instead.** One line in `src/validate/lane-emit.js`:

```js
// instead of:  export { scanForNetworkReferences, assertProvenance } from '../emit/index.js';
export { scanForNetworkReferences } from '../emit/scan.js';
export { assertProvenance } from '../emit/provenance.js';
```

Neither of those modules imports `emit/emit.js`, so the cycle disappears and
`emit()` can call `runPreflight` directly — one call instead of a reconstructed
context, and no possibility of the two drifting. It is L11's file, so it is
L11's call; recorded here because the workaround is otherwise unexplained.

---

## L10-D9 — two readers of the promotion-record format disagree

**The contract.** `API.md` gives L7 `promoteProvenance(rendition, {by, at})` as
"the only route to `verified-by-user`". L7 also publishes
`hasPromotionRecord(rendition)`, which reads the record it wrote.

**The objection.** `src/validate/provenance.js` carries a *second* reader —
`PROMOTION_PATTERN` and its own `hasPromotionRecord` — and `runPreflight`
defaults to it. They do not agree. A rendition promoted through
`promoteProvenance` is recognised by L7's reader and rejected by L11's, so
`runPreflight` reports `PROVENANCE_UNLABELED` at **severity 1** against a
rendition that was properly promoted. In the studio that disables the emit
button on an honest proof, while `emit()` — which reads the record with L7's
reader (decision E17) — accepts it. The two gates disagree about the same file.

This is the failure E17 was written to avoid: "two readers of one format is one
reader too many. The moment they disagree, the artifact ships either an
unlabelled lie or a false refusal, and neither lane would know which of them was
wrong."

**Built as written.** The emitter reads promotion records with L7's reader and
passes it into the rules as `ctx.deps.hasPromotionRecord`, which
`validate/rules.js` prefers over its own fallback. `test/emit/gate.test.mjs`
injects the same reader into `runPreflight` so its equivalence assertion is
about the *rules* rather than about which promotion reader was in scope, and
`test/emit/gate.test.mjs` separately asserts that a rendition promoted through
L7 is not reported as unpromoted.

**What we would propose instead.** Delete the reader in
`src/validate/provenance.js` and re-export L7's, the way `lane-brand.js` and
`lane-scene.js` already re-export L4's and L8's. One format, one reader, and
`resolveDeps` needs no default for it.

---

## L10-D10 — `LogoAsset.kind: 'svg'` is read two ways

**The contract.** §4: `LogoAsset.data` is "inline SVG markup or data URI", for
either value of `kind`.

**The objection.** L11's `ASSET_MISSING` rule requires a `kind: 'svg'` logo to
carry literal `<svg` markup and reports "no usable SVG markup" at severity 1 for
a `data:image/svg+xml,…` URI — which the contract permits and which is, in
substance, SVG. A contract-legal proof is refused.

**Built as written.** The emitter runs the rule unchanged, and the lane's fixture
now carries its `kind: 'svg'` logo as inline markup — which §7 prefers anyway
("Prefer inline SVG"), so the fixture is more realistic for the change. The
divergence is recorded rather than worked around.

**What we would propose instead.** Accept either payload for either `kind`, and
raise the finding only when `data` is neither markup nor a parseable data URI.
The `kind` field then describes the asset rather than constraining how it was
delivered.

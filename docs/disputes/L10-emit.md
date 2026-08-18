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

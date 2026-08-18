# CONTRACTS-DISPUTES

The channel required by §4: a lane that believes a frozen contract is wrong
records the objection here **and builds against the contract as written anyway**.
Nothing in this file changes `src/core/contracts.d.ts`; the frozen region is
enforced by `test/core/contracts-freeze.test.mjs`.

Each lane filed its objections in full in `docs/disputes/L<n>-*.md`, with the
reasoning, what it built instead (always: the contract as written), and what a
v2 contract should say. This file is the index — one line per objection, so the
§20 critic can check axis 1 without reading six documents, and so a v2 of the
contracts has a single work list.

**Every objection below was built against as written.** Nothing was renamed,
retyped or removed.

---

## Against the §4 frozen contracts

These want a v2 of `contracts.d.ts`. All were worked around with optional
extension fields or encoded records, which §4 permits.

| # | Lane | Contract | Objection | Worked around by |
|---|---|---|---|---|
| 1 | L7 | `Rendition` | No field to record a promotion to `verified-by-user`, though §9 requires "an explicit user promotion that records who promoted it and when" | A signed record encoded in `notes` (`[[pp-promotion:1;…]]`), stripped from caller-supplied notes so `promoteProvenance` is its only writer |
| 2 | L7, L8 | `Rendition.notes` | One free-text field doing two jobs: a human annotation and a machine audit record | The record convention `[[pp-<kind>:<version>;k=v;…]]`, appended after any prose |
| 3 | L7 | `Provenance` | Cannot distinguish "the tool rearranged the client's own words" from "a model wrote this" — both are `illustrative` | Labelled as `illustrative`, which is the safe direction |
| 4 | L6 | `Specimen` | No field for the untouched source, though §8 requires keeping one, and none for §18.3's "if a specimen was edited, the artifact says so" | Optional `raw`, `rawOptIn`, `edited`, `editNotes` |
| 5 | L6 | `ContentBlock` `list`/`table` | Cannot express nesting or cell spans | Flattened, with the loss recorded in the block trace |
| 6 | L6, L5 | `MediaRef` | Cannot say an asset was **not** downscaled, which the emitter's budgeter needs | Optional `needsDownscale`, `resizeSkipped` |
| 7 | L5 | `TypeFace.metricDelta` | One triple for a family whose metrics vary per weight | One triple at a documented weight, with `primaryWeight` recorded |
| 8 | L5 | `TypeFace.embeddable` | Cannot carry the licence assertion its own §7 comment depends on | Optional `rightsAssertion`, `fontFile`; `attachUserFont` is the only route to `true` |
| 9 | L5 | `LogoAsset` | Nowhere to say §7's "a proper inverse asset is needed" | Optional `needsInverseAsset` |
| 10 | L5 | `BrandSystem.imagery.saturationBias` | A bare `number` with no declared scale | Defined as signed −1..+1 about an exported anchor |
| 11 | L8 | `Scene` | Nowhere to record how its beats were grouped | Derived from the layout's own structure |

## Against `API.md` (the integration surface, not the frozen contracts)

These were resolved by amending `API.md`, which is mine to change — it is the
integrator's document, not a frozen contract.

| # | Lane | Surface | Objection | Resolution |
|---|---|---|---|---|
| 12 | L9 | `branchCoverage` | Returns ids without reasons, so L11 cannot grade them | Lane publishes `details[]` with machine-readable `reasons`; severity split agreed (`unanchored` 2, structural 1) |
| 13 | L7 | `channelBudget` | Too flat a shape for a real channel, which has per-part budgets | Returns a superset; the declared fields are present and unchanged |
| 14 | L7 | `runAdapter` | Declared as one rendition per call, but every seed recipe is a fan-out | Built as declared, with an optional `label` in config |
| 15 | L6 | `stripChrome(doc, {siblings})` | `siblings` was never specified | Now accepts `DocNode` roots, `RawCapture` objects and `{root}` wrappers, mixed |
| 16 | L4 | `solveRoles(clusters, {seed})` | No floor parameter | Optional `minRatio` added; the 4.5:1 post-condition is unconditional |
| 17 | L9 | `OverlayDefinition` | An overlay cannot receive input through the surface it is given | Lane publishes `installBranchInputBridge`; the composition root calls it |
| 18 | L8 | `measureScene(scene, ctx, breakpoint)` | Takes the scene twice (`scene` and `ctx.scene`) | Built as declared; the two are asserted equal |
| 19 | L8 | `LayoutContext` | Cannot see the recipes that produced its renditions, nor the breakpoint it renders at | Built as declared — a layout that saw the breakpoint could not be a pure function of its context |
| 20 | L8 | `SceneMeasurement.boxes` | Cannot express cumulative overflow across sibling boxes | Per-box, as declared; L11 aggregates |

## Defects found in already-frozen code, and closed

| # | Found by | Where | What | Closed |
|---|---|---|---|---|
| D1 | L9's return-stack property test | `src/runtime/nav.js` (L2) | `exitedFrom` recorded one return frame where `returnPolicy: 'nextSpineScene'` unwinds the whole stack, so stepping back left the stack floored on a branch and the next return threw — the §22.4 stranding case | `ec1dd38`; DECISIONS D18. L9 removed its fence and replaced its pin with a regression test |
| D2 | L9's overlay work | `src/runtime/keymap.js` (L2) | `ArrowUp`/`ArrowDown` resolved to `prevScene`/`nextScene` while a text field had focus, so arrowing through the jump results also walked the presentation behind the overlay | Fixed: while typing, only `whileTyping` bindings resolve, which is Escape alone. L9's capture-phase interception is now the outer of two defences rather than the only one |

## Recorded non-disputes

Observations where the contract permits the behaviour as written, kept so the
critic does not re-derive them: `ColorToken.contrastWithPair` has no pairing
table in the contract, so L1 publishes `ROLE_PAIR` (adds no field, retypes
nothing); `Beat.dwellHintMs` is read only by the presenter view, never by a
timer; `ROLE_PAIR` pairs `border`/`success`/`warning`/`danger` with `surface`
though none is a `FOREGROUND_ROLES` entry, so L4 imposes 3:1 and 4.5:1 floors of
its own; `ColorToken.source` has no value for "chosen from the brand's palette
but not by the user"; `ColorToken.oklch` states no hue convention for achromatic
colours.

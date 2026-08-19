/**
 * Provenance, enforced in the model (§9, §18.1, §22.6).
 *
 * §22.6 names provenance leakage "the single reputational risk in this product":
 * a proof that implies generated sample content is the client's approved copy.
 * L10 enforces the label at the emitter. This module makes the *model* unable to
 * carry the lie in the first place:
 *
 * - `buildRendition` defaults every rendition to `'illustrative'`. Only an
 *   explicit `'client-supplied'` from the caller sets anything else.
 * - `producedBy: 'adapter'` forces `'illustrative'`, whatever the caller asked
 *   for. A generation endpoint's output is never the client's content.
 * - `'verified-by-user'` is unreachable except through `promoteProvenance`,
 *   which writes a structured, machine-readable promotion record naming who
 *   promoted it and when.
 * - `buildRendition` **strips** any promotion record found in caller-supplied
 *   notes, because forging the record is exactly the attack the record exists to
 *   defeat.
 * - `hasPromotionRecord` lets L10 and L11 detect a rendition that claims
 *   `'verified-by-user'` without one. That combination is a forgery.
 *
 * ---
 *
 * ## The promotion record format (frozen for L10 and L11)
 *
 * `Rendition` is a frozen §4 contract with no promotion field, so the record
 * lives in `notes` — see `docs/disputes/L7-recipes.md` for the objection filed
 * against that, and `docs/decisions/L7-recipes.md` D-L7-2 for the format's
 * rationale. It is exactly one line, appended after any human notes:
 *
 * ```
 * [[pp-promotion:1;by=<base64url>;at=<iso8601>;of=<renditionId>;from=<provenance>;sig=<16 hex>]]
 * ```
 *
 * | field | meaning |
 * |---|---|
 * | `1` after the colon | record format version |
 * | `by` | base64url (unpadded) of the UTF-8 promoter identity, so any character is safe inside the delimiters |
 * | `at` | ISO-8601 instant from the caller's injected clock — `YYYY-MM-DDTHH:MM:SS[.mmm]Z` or with a `±HH:MM` offset |
 * | `of` | the id of the rendition being promoted; a record copied onto another rendition does not verify |
 * | `from` | the provenance the rendition held before promotion |
 * | `sig` | `shortHash({v, by, at, of, from}, 16)` — an integrity digest, **not** a signature |
 *
 * Parsing: `readPromotionRecords(rendition)` returns every valid record, oldest
 * first; `readPromotionRecord(rendition)` returns the last one; and
 * `hasPromotionRecord(rendition)` is `readPromotionRecord(rendition) !== null`.
 * Records whose digest does not recompute, or which name another rendition, are
 * ignored by all three and surfaced by `verifyProvenance`.
 *
 * ---
 *
 * ## What `sig` proves, and what it does not (finding F23)
 *
 * **It is tamper-evidence against corruption. It is not authentication.** The
 * §20 critique found that a field named `signatureValid` invites every reader —
 * of the code and of the studio — to take a `true` as "a person really promoted
 * this". It does not mean that, and this module will not let the name imply it.
 * `PromotionRecord` therefore carries **`recordIntact`**, which says what is
 * true. `signatureValid` remains as an alias with the identical value, because
 * L12's rendition panel and `src/validate/provenance.js`'s published typedef
 * already read it (see `docs/decisions/L7-recipes.md` D-L7-17); new code should
 * read `recordIntact`.
 *
 * `recordIntact === true` means exactly four things, and nothing else:
 *
 * 1. the record's format version is one this build knows;
 * 2. its `at` is a real calendar instant;
 * 3. its `by` decodes as UTF-8; and
 * 4. `shortHash({v, by, at, of, from}, 16)` recomputes to the `sig` in the line.
 *
 * A fifth condition — `of` equals the rendition's own id — is applied by
 * `readPromotionRecords`, not by the digest, and is the structurally strongest
 * check here: it is what stops a real record being copied from one rendition
 * onto another.
 *
 * What `recordIntact === true` does **not** mean: that the named person exists,
 * that they saw this rendition, that they consented, or that the record was
 * written by `promoteProvenance` rather than typed. `promotionSignature` and
 * `formatPromotionRecord` are exported from `src/recipe/index.js`; anyone with
 * a copy of this repository can call them and mint a record that passes every
 * check above. `test/recipe/provenance.test.mjs` proves this deliberately — see
 * the tests named `LIMIT:` — because a comment claiming a limit is weaker than
 * a test demonstrating one.
 *
 * **Why it cannot be better here.** §1.1.5 forbids an account system, cloud
 * sync and any backend, and §1.1.1 forbids the artifact touching the network at
 * all. A signature is only worth more than a checksum when a verifier holds a
 * key the forger does not. In a wholly local, single-user, offline product
 * there is no such party: any key this code could sign with would have to ship
 * inside the same artifact the forger already has, which makes it a checksum
 * with extra steps. An unkeyed digest is therefore the strongest honest
 * construction available, and the honest thing to do with it is to name it
 * accurately rather than to dress it up.
 *
 * **What actually defends §22.6**, in descending order of strength:
 *
 * 1. `'verified-by-user'` is unreachable from `buildRendition` at any provenance
 *    the caller asks for — `promoteProvenance` is the only writer.
 * 2. `buildRendition` strips any promotion record found in caller-supplied
 *    notes, so a record cannot ride in on an import.
 * 3. `of` binds a record to one rendition id, so records cannot be shared.
 * 4. `renditionsRequiringLabel` defaults to labelling: anything that is not
 *    `'client-supplied'`, and not a `'verified-by-user'` with a record, is
 *    labelled — the failure mode of every check above is a *visible* label.
 * 5. The digest, which catches truncation and hand-editing.
 *
 * Note the shape of that list: an adversary editing the model by hand does not
 * need to forge a digest at all, because setting `provenance: 'client-supplied'`
 * suppresses the label with no record of any kind. The digest is not the
 * weakest link in this model and strengthening it would not move the floor.
 * Against a user editing their own local files, in a product with no server,
 * there is no floor to move; the guarantee this module actually offers is that
 * **nothing the tool itself does can produce an unearned `'verified-by-user'`**.
 *
 * ---
 *
 * ## If you are re-implementing this reader, know these five things
 *
 * L10 found a second reader of this format in `src/validate/provenance.js` that
 * did not recognise records `promoteProvenance` actually writes. It is being
 * deleted in favour of this one. These are the parts a note-scraper gets wrong,
 * written down so the next person does not have to rediscover them:
 *
 * 1. **`PROMOTION_RECORD_RE` is a `/g` regex, and `lastIndex` is shared state.**
 *    It is exported because L10 and L11 asked for it, but `.test()` or `.exec()`
 *    on it alternates between hit and miss across calls unless you reset
 *    `lastIndex = 0` first, as `parsePromotionRecords` does. Prefer calling
 *    `parsePromotionRecords`; if you must use the regex, reset it.
 * 2. **`by` is base64url, not plain text.** A scraper looking for `by=Dana`
 *    finds nothing; the record says `by=RGFuYQ`. Decoding can throw on a
 *    corrupted record, which is caught here and reported as not intact.
 * 3. **A record is only usable for the rendition it names.** `of` must equal
 *    `rendition.id`. Validity is not a property of the line alone, so a reader
 *    that takes a notes *string* rather than a *rendition* cannot answer the
 *    question and will accept a record copied off another rendition.
 * 4. **Records accumulate; the last one stands.** Re-promotion appends, and each
 *    record's `from` names what it superseded. Reading the first match gives the
 *    wrong promoter and the wrong `from` on any twice-promoted rendition.
 * 5. **Invalid records are ignored by the readers and reported by
 *    `verifyProvenance`.** That split is deliberate: a reader that threw on a
 *    malformed record would let a hand-edited note break the whole preflight,
 *    and one that silently dropped it would lose the finding. If you need the
 *    reason a record did not count, call `verifyProvenance`, not the readers.
 *
 * @module recipe/provenance
 */

import { contentId } from '../core/ids.js';
import { shortHash } from '../core/hash.js';
import { utf8Encode, utf8Decode, base64Encode, base64Decode } from '../core/bytes.js';
import { PROVENANCE_VALUES, validateRendition } from '../core/contracts.js';

/** Record format version. Bump only with L10 and L11. */
export const PROMOTION_RECORD_VERSION = 1;

/**
 * The one honest sentence about `sig`, in a single place so no surface has to
 * invent its own wording for it (finding F23). Any studio or preflight surface
 * that shows a person the outcome of `recordIntact` should show this alongside
 * it rather than paraphrasing.
 */
export const PROMOTION_RECORD_LIMIT =
  'The promotion record is checked against itself, not against an authority. '
  + 'PitchProof has no accounts and no server, so a valid record proves the line '
  + 'has not been corrupted or partly edited — it does not prove that the person '
  + 'named promoted anything.';

/** Matches one promotion record anywhere in a notes string. */
export const PROMOTION_RECORD_RE =
  /\[\[pp-promotion:(\d+);by=([A-Za-z0-9_-]*);at=([0-9T:.+\-Z]+);of=([A-Za-z0-9_-]+);from=([a-z-]+);sig=([0-9a-f]{16})\]\]/g;

/** Strict ISO-8601 instant. Validated by pattern and by calendar, never by `Date`. */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * base64url without padding — safe inside the record delimiters.
 * @param {string} s
 * @returns {string}
 */
function b64url(s) {
  return base64Encode(utf8Encode(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {string} s
 * @returns {string}
 */
function unb64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return utf8Decode(base64Decode(s.replace(/-/g, '+').replace(/_/g, '/') + pad));
}

/**
 * True for a well-formed ISO-8601 instant with a real calendar date.
 * @param {string} s
 * @returns {boolean}
 */
export function isIsoInstant(s) {
  const m = ISO_RE.exec(String(s == null ? '' : s));
  if (!m) return false;
  const [, y, mo, d, h, mi, sec] = m;
  const year = Number(y); const month = Number(mo); const day = Number(d);
  if (month < 1 || month > 12) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 60) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= lengths[month - 1];
}

/**
 * The digest that makes a truncated or hand-edited record detectable.
 *
 * **Unkeyed, and exported.** This is the whole of finding F23: any caller —
 * including one hand-writing a record — can compute a `sig` that validates.
 * See the module header for why no keyed alternative exists in a product with
 * no backend and no accounts (§1.1.5), and what defends §22.6 instead.
 *
 * @param {{v: number, by: string, at: string, of: string, from: string}} fields
 * @returns {string} 16 hex characters
 */
export function promotionSignature(fields) {
  return shortHash({
    v: fields.v, by: fields.by, at: fields.at, of: fields.of, from: fields.from,
  }, 16);
}

/**
 * Serialize a promotion record.
 *
 * Exported for round-tripping and for the `LIMIT:` tests. It is **not** an
 * authorisation: a record this produces validates wherever `of` matches, no
 * matter who called it. `promoteProvenance` is the only function that attaches
 * one to a rendition and moves its provenance.
 *
 * @param {{by: string, at: string, of: string, from: string}} fields
 * @returns {string}
 */
export function formatPromotionRecord(fields) {
  const encodedBy = b64url(fields.by);
  const sig = promotionSignature({
    v: PROMOTION_RECORD_VERSION, by: encodedBy, at: fields.at, of: fields.of, from: fields.from,
  });
  return `[[pp-promotion:${PROMOTION_RECORD_VERSION};by=${encodedBy};at=${fields.at};of=${fields.of};from=${fields.from};sig=${sig}]]`;
}

/**
 * @typedef {object} PromotionRecord
 * @property {number} version
 * @property {string} by        decoded promoter identity
 * @property {string} at        ISO instant
 * @property {string} of        rendition id the record was written for
 * @property {string} from      provenance held before promotion
 * @property {string} raw       the record exactly as it appeared
 * @property {boolean} recordIntact    the record recomputes against itself: known
 *   version, real calendar `at`, decodable `by`, and a `sig` that matches. It
 *   means the line has not been corrupted or partially edited — **not** that a
 *   person promoted anything. See the module header, finding F23.
 * @property {boolean} signatureValid  deprecated alias of `recordIntact`, kept
 *   because L12's rendition panel and `src/validate/provenance.js`'s typedef
 *   already read it. Always identical to `recordIntact`; the name overstates
 *   what it knows, so read `recordIntact` in new code.
 */

/**
 * Parse every promotion record in a notes string, intact or not.
 *
 * Nothing here is filtered: a record whose digest fails is returned with
 * `recordIntact: false` so `verifyProvenance` can report *why*.
 *
 * @param {string|null|undefined} notes
 * @returns {PromotionRecord[]} source order
 */
export function parsePromotionRecords(notes) {
  const text = typeof notes === 'string' ? notes : '';
  /** @type {PromotionRecord[]} */
  const out = [];
  PROMOTION_RECORD_RE.lastIndex = 0;
  let m;
  while ((m = PROMOTION_RECORD_RE.exec(text)) !== null) {
    const [raw, v, by, at, of, from, sig] = m;
    const expected = promotionSignature({ v: Number(v), by, at, of, from });
    let decoded = '';
    try { decoded = unb64url(by); } catch { decoded = ''; }
    const intact = expected === sig
      && Number(v) === PROMOTION_RECORD_VERSION
      && isIsoInstant(at)
      && decoded !== '';
    out.push({
      version: Number(v),
      by: decoded,
      at,
      of,
      from,
      raw,
      recordIntact: intact,
      // Deprecated alias. Same fact, misleading name; see the module header.
      signatureValid: intact,
    });
  }
  return out;
}

/**
 * The usable promotion records carried by a rendition: digest intact, format
 * version known, and written for *this* rendition.
 *
 * "Usable" is the honest word. It means the record is well-formed and bound to
 * this rendition — not that its `by` names anyone real. See finding F23 in the
 * module header.
 *
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {PromotionRecord[]} oldest first
 */
export function readPromotionRecords(rendition) {
  if (!rendition || typeof rendition !== 'object') return [];
  return parsePromotionRecords(rendition.notes)
    .filter((r) => r.recordIntact && r.of === rendition.id);
}

/**
 * The record that currently stands for a rendition, or `null`.
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {PromotionRecord|null}
 */
export function readPromotionRecord(rendition) {
  const all = readPromotionRecords(rendition);
  return all.length ? all[all.length - 1] : null;
}

/**
 * Does this rendition carry an intact promotion record written for it?
 *
 * L10 and L11 call this to detect a `'verified-by-user'` with nothing behind
 * it. **A `true` answer means a promotion was recorded** — it does not mean the
 * person named exists, saw this rendition, or consented. This is the single
 * gate downstream: `requiresProvenanceLabel` (L10), `PROVENANCE_UNLABELED`
 * (L11) and `renditionsRequiringLabel` all turn on this boolean and none of
 * them draws any further distinction from the digest. See finding F23.
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {boolean}
 */
export function hasPromotionRecord(rendition) {
  return readPromotionRecord(rendition) !== null;
}

/**
 * Strip every promotion record — valid or not — from a notes string.
 * @param {string|null|undefined} notes
 * @returns {string|null}
 */
export function stripPromotionRecords(notes) {
  if (typeof notes !== 'string') return null;
  const cleaned = notes
    .replace(PROMOTION_RECORD_RE, '')
    .replace(/\[\[pp-promotion:[^\]]*\]\]/g, '');
  const kept = cleaned.split('\n').map((l) => l.replace(/[ \t]+$/, '')).filter((l) => l.trim() !== '');
  return kept.length ? kept.join('\n') : null;
}

/**
 * Resolve the provenance a rendition is allowed to have at construction.
 *
 * The whole of §22.6's model side is these six lines: the only value a caller
 * can choose is `'client-supplied'`, the adapter can choose nothing, and
 * `'verified-by-user'` is not reachable from here at all.
 *
 * @param {unknown} requested
 * @param {'manual-paste'|'adapter'|'template'} producedBy
 * @returns {import('../core/contracts.d.ts').Provenance}
 */
export function resolveProvenance(requested, producedBy) {
  if (producedBy === 'adapter') return 'illustrative';
  if (requested === 'client-supplied') return 'client-supplied';
  return 'illustrative';
}

/**
 * Content-derived rendition id.
 *
 * Deliberately excludes `provenance` and `notes`: promoting a rendition must not
 * change its id, or every `Scene.renditionIds` reference would break the moment
 * a user verified something. See D-L7-3.
 *
 * @param {{specimenId: string, recipeId: string, label: string, blocks: unknown, media: unknown, producedBy: string}} parts
 * @returns {string}
 */
export function renditionId(parts) {
  return contentId('rendition', {
    specimenId: parts.specimenId,
    recipeId: parts.recipeId,
    label: parts.label,
    blocks: parts.blocks,
    media: parts.media,
    producedBy: parts.producedBy,
  });
}

/**
 * Build a contract-valid `Rendition` under the provenance law.
 *
 * @param {object} args
 * @param {import('../core/contracts.d.ts').Specimen|{id: string}} args.specimen
 * @param {import('../core/contracts.d.ts').Recipe|{id: string}} args.recipe
 * @param {string} args.label
 * @param {import('../core/contracts.d.ts').ContentBlock[]} args.blocks
 * @param {import('../core/contracts.d.ts').MediaRef[]} [args.media]
 * @param {'manual-paste'|'adapter'|'template'} args.producedBy
 * @param {import('../core/contracts.d.ts').Provenance} [args.provenance]
 * @param {string|null} [args.notes]
 * @returns {import('../core/contracts.d.ts').Rendition}
 */
export function buildRendition({ specimen, recipe, label, blocks, media = [], producedBy, provenance, notes = null }) {
  const specimenId = typeof specimen === 'string' ? specimen : specimen && specimen.id;
  const recipeId = typeof recipe === 'string' ? recipe : recipe && recipe.id;
  if (typeof specimenId !== 'string' || !specimenId) throw new Error('buildRendition: specimen id is required');
  if (typeof recipeId !== 'string' || !recipeId) throw new Error('buildRendition: recipe id is required');
  if (typeof label !== 'string' || !label) throw new Error('buildRendition: label is required');
  if (!Array.isArray(blocks)) throw new Error('buildRendition: blocks must be an array');
  if (!Array.isArray(media)) throw new Error('buildRendition: media must be an array');
  if (producedBy !== 'manual-paste' && producedBy !== 'adapter' && producedBy !== 'template') {
    throw new Error(`buildRendition: producedBy must be manual-paste|adapter|template, got ${String(producedBy)}`);
  }
  if (provenance !== undefined && !PROVENANCE_VALUES.includes(/** @type {string} */(provenance))) {
    throw new Error(`buildRendition: unknown provenance ${String(provenance)}`);
  }

  // Only `promoteProvenance` may write a promotion record. A record arriving in
  // caller-supplied notes is either stale or forged; both are removed.
  const cleanNotes = stripPromotionRecords(notes);

  const resolved = resolveProvenance(provenance, producedBy);
  const id = renditionId({ specimenId, recipeId, label, blocks, media, producedBy });

  /** @type {import('../core/contracts.d.ts').Rendition} */
  const rendition = {
    id,
    specimenId,
    recipeId,
    label,
    blocks,
    media,
    provenance: resolved,
    producedBy,
    notes: cleanNotes,
  };

  /** @type {string[]} */
  const errs = [];
  validateRendition(rendition, 'rendition', errs);
  if (errs.length) throw new Error(`buildRendition: invalid rendition\n  ${errs.join('\n  ')}`);
  return rendition;
}

/**
 * Promote a rendition to `'verified-by-user'`. **The only route to that value.**
 *
 * Throws rather than returning an unpromoted rendition when `by` or `at` is
 * missing or malformed: a promotion that silently did not happen is the same
 * failure §22.6 is about, one step removed.
 *
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @param {{by: string, at: string}} who
 * @returns {import('../core/contracts.d.ts').Rendition} a new rendition; the input is untouched
 */
export function promoteProvenance(rendition, { by, at } = /** @type {any} */({})) {
  if (!rendition || typeof rendition !== 'object') throw new Error('promoteProvenance: rendition is required');
  if (typeof by !== 'string' || !by.trim()) throw new Error('promoteProvenance: `by` must name who promoted this rendition');
  if (typeof at !== 'string' || !isIsoInstant(at)) {
    throw new Error('promoteProvenance: `at` must be an ISO-8601 instant from the injected clock, e.g. 2026-08-18T09:30:00.000Z');
  }
  if (typeof rendition.id !== 'string' || !rendition.id) throw new Error('promoteProvenance: rendition.id is required');

  const from = PROVENANCE_VALUES.includes(rendition.provenance) ? rendition.provenance : 'illustrative';
  const record = formatPromotionRecord({ by: by.trim(), at, of: rendition.id, from });
  const existing = typeof rendition.notes === 'string' ? rendition.notes.trim() : '';
  const notes = existing ? `${existing}\n${record}` : record;

  const promoted = { ...rendition, provenance: /** @type {const} */('verified-by-user'), notes };

  /** @type {string[]} */
  const errs = [];
  validateRendition(promoted, 'rendition', errs);
  if (errs.length) throw new Error(`promoteProvenance: invalid rendition\n  ${errs.join('\n  ')}`);
  return promoted;
}

/**
 * Undo a promotion, back to the provenance the record says it came from. The
 * record stays in `notes` as history and a `[[pp-demotion:1;…]]` line is not
 * written — the promotion record's presence alongside a non-verified provenance
 * is itself the honest signal, and `verifyProvenance` reports it as such.
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {import('../core/contracts.d.ts').Rendition}
 */
export function demoteProvenance(rendition) {
  const record = readPromotionRecord(rendition);
  const back = record && PROVENANCE_VALUES.includes(record.from) ? record.from : 'illustrative';
  return { ...rendition, provenance: /** @type {any} */(back === 'verified-by-user' ? 'illustrative' : back) };
}

/**
 * Everything wrong with a rendition's provenance, one string per problem.
 * **Empty means clean**, matching `validateProofShape`.
 *
 * L10 turns a non-empty result into `PROVENANCE_UNLABELED` at severity 1; L11
 * surfaces it in preflight. Both must be able to reach this verdict without
 * trusting the studio UI (§9, §22.6).
 *
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {string[]}
 */
export function verifyProvenance(rendition) {
  /** @type {string[]} */
  const out = [];
  if (!rendition || typeof rendition !== 'object') return ['rendition: not an object'];
  const { provenance, producedBy, id } = rendition;

  if (!PROVENANCE_VALUES.includes(provenance)) {
    out.push(`rendition ${id}: provenance "${String(provenance)}" is not a Provenance value`);
  }
  if (producedBy === 'adapter' && provenance === 'client-supplied') {
    out.push(`rendition ${id}: adapter-produced content may never be marked client-supplied (§9)`);
  }

  const parsed = parsePromotionRecords(rendition.notes);
  const valid = parsed.filter((r) => r.recordIntact && r.of === id);

  for (const r of parsed) {
    if (!r.recordIntact) out.push(`rendition ${id}: promotion record fails its signature — hand-edited or truncated`);
    else if (r.of !== id) out.push(`rendition ${id}: promotion record was written for ${r.of}, not this rendition`);
  }

  if (provenance === 'verified-by-user' && valid.length === 0) {
    out.push(`rendition ${id}: claims verified-by-user with no valid promotion record — forged (§22.6)`);
  }
  if (provenance !== 'verified-by-user' && valid.length > 0) {
    out.push(`rendition ${id}: carries a promotion record but is not verified-by-user — promotion was withdrawn`);
  }
  return out;
}

/**
 * The renditions in a proof whose provenance requires the artifact to carry a
 * visible label (§9, §18.1). L10 asserts a label node exists for each of these.
 *
 * Default-to-labelled: a rendition leaves this set only by being
 * `'client-supplied'`, or by being `'verified-by-user'` **and** carrying an
 * intact record. Both of those are assertions a person made about their own
 * local model, and neither is authenticated — see finding F23. What this
 * function guarantees is narrower and still worth having: nothing the tool
 * itself produces can leave the set on its own.
 *
 * @param {import('../core/contracts.d.ts').Rendition[]} renditions
 * @returns {import('../core/contracts.d.ts').Rendition[]}
 */
export function renditionsRequiringLabel(renditions) {
  return (renditions || []).filter((r) => {
    if (!r) return false;
    if (r.provenance === 'client-supplied') return false;
    if (r.provenance === 'verified-by-user') return hasPromotionRecord(r) === false;
    return true;
  });
}

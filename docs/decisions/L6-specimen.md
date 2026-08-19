# L6 Specimen — lane decisions

Judgment calls the spec did not settle, recorded per §23 in the style of
`DECISIONS.md`. Numbered `D-L6-n` so they can be merged into the top-level
document at integration without renumbering D1–D17.

---

## D-L6-1 — Chrome is decided by a scored classifier over four signals, with a threshold of 1.0

**Unsettled by:** §8 and PLAN §4.3 name the four signals — landmarks, link
density, boilerplate lexicon, repetition across pages — and say they are
"combined with a scored classifier rather than a single rule", but not how they
are weighted or where the line falls.

**Decision.** Each signal returns evidence in units where **1.0 means "decisive
on its own"**. The score is `landmark + linkDensity + boilerplate + repeated −
content`, and a block is chrome at **≥ 1.0** (`CHROME_THRESHOLD`). Repetition is
the strongest single contributor (text repeat 1.6–1.8, structural repeat
1.0–1.2), then landmarks (1.05–1.35), then the lexicon (≤ 1.5), then link
density (≤ 1.4). A negative **content signal** (prose volume, full paragraphs,
headings with prose, article landmarks, ≤ 1.7) is subtracted.

Three guards raise the bar rather than lower the score:

- **dominant block** — a block holding ≥ 50% of the root's non-link text needs
  1.7 (`DOMINANT_THRESHOLD`);
- **headline** — a block containing the page's own `h1` needs 2.0
  (`HEADLINE_THRESHOLD`); a site header whose logo is an `h1` still scores far
  above that and still goes;
- **prose** — for a single long text block (≥ 200 chars) with no landmark, link
  or repetition evidence, lexicon evidence is capped at 0.4, so an article that
  discusses cookie consent and quotes "accept all" is not mistaken for a banner.

**Why.** A sum with an explicit threshold is inspectable: every removal carries
its per-signal breakdown, so a reviewer in the studio can see *why*, and a
regression names the signal that moved. Weights were calibrated against the
§17.5 corpus, but every adjustment made during calibration was a structural fix
(see D-L6-3, D-L6-10, D-L6-11) rather than a constant nudged until the number
went green — which is why the classifier still scores F1 0.95+ when every class
and id in the corpus is hashed beyond recognition.

---

## D-L6-2 — Elements that render nothing are dropped silently; only content decisions are logged

**Unsettled by:** §8 requires stripping to be reversible, but not at what
granularity.

**Decision.** `script`, `style`, `noscript`, `template`, `iframe` and comments
are removed before classification and are **not** entered in the removal log.
Everything that could have produced a `ContentBlock` is logged with its reason,
score, signal breakdown, structural path and index path.

**Why.** The restore list in the studio is a review surface. Filling it with
forty script tags buries the one decision a reviewer might disagree with. The
untouched `raw` HTML on the specimen remains the complete record, so nothing is
actually lost.

---

## D-L6-3 — Lists, tables, quotes, figures, `pre` and headings are judged whole

**Unsettled by:** §8 says to strip chrome by block; §4 defines a list or a table
as **one** `ContentBlock`.

**Decision.** `ATOMIC_CONTAINERS` — `blockquote`, `figure`, `table`, `pre`,
`dl`, `p`, `ul`, `ol`, `menu`, `h1`–`h6` — are scored as units and never
descended into.

**Why.** This is a contract boundary, not a heuristic. Removing one `<li>` from
a list would produce a half-block that neither side of a before/after pair
should show, and removing the `<footer>` of a `<blockquote>` would silently
delete the attribution — which is exactly the kind of quiet mutilation §18.3
forbids.

---

## D-L6-4 — Nested list items are flattened with an em-dash depth marker

**Unsettled by:** `ContentBlock.list.items` is `string[]`, so nesting has
nowhere to go.

**Decision.** A nested list's items join their parent list, prefixed with
`— ` per level of nesting.

**Why.** The alternatives are dropping the nested items (loses the prospect's
content) or emitting a second list block (loses the relationship and doubles the
block count). A visible marker keeps both the words and the structure legible,
and it survives round-tripping through a rendition.

---

## D-L6-5 — `colspan` is expanded, `rowspan` is not

**Unsettled by:** `ContentBlock.table.rows` is `string[][]`, which cannot express
spans.

**Decision.** A cell with `colspan="n"` is repeated `n` times so every row has
the same length; `rowspan` is ignored and the cell appears only in its first
row.

**Why.** Ragged rows break every layout that renders a table. Repeating across
columns keeps the grid rectangular at the cost of a duplicated string a viewer
reads as a merged cell anyway. Repeating *down* rows would put a value in a row
the source page never showed it in, which is a change to the prospect's content
(§18.3), so it is not done.

---

## D-L6-6 — What happens to each media format, exactly

**Unsettled by:** §8 says "inline all media as data URIs at capture time,
downscaled to a max edge of 2400px, recompressed at the project's
`imageQuality`" — in a repository with no image codecs and, in Node, no canvas.

**Decision.**

| Input | Decoded | Downscaled to 2400 | Recompressed | Reported |
|---|---|---|---|---|
| PNG | yes, in-repo decoder on `core/inflate.js` | yes, area-average box filter | yes, in-repo encoder on `core/deflate.js` | `resized`, `recompressed`, exact `intrinsic`, exact `bytes` |
| JPEG | no | **no** | no — bytes passed through unchanged | `resized: false`, `needsDownscale: true`, `resizeSkipped: 'jpeg-no-encoder'` |
| GIF / WebP / BMP / ICO | no | no | no — passed through | as JPEG |
| SVG | n/a | n/a (vector) | no | `intrinsic` from `width`/`height` or `viewBox`; `svg:script` and `svg:external-reference` flagged |
| anything else | — | — | — | skipped; never given invented dimensions |

The PNG decoder covers bit depths 1/2/4/8/16, colour types 0/2/3/4/6, all five
filters, `tRNS`, and both interlace methods. The encoder writes 8-bit colour
type 2, 6 or 3 with adaptive per-scanline filtering. Colour management (`gAMA`,
`iCCP`) is not applied: pixels are treated as sRGB as authored, which is what a
browser does with an untagged image.

**Why.** Writing half a JPEG encoder would produce visibly worse images than the
originals while claiming to have "recompressed" them. Passing the bytes through
and telling L10's budgeter that the asset is **not** resized is the honest
option and the one §13's "report exactly what was degraded and by how much —
never silently" asks for. PNG is where UI screenshots and logos live, which is
what a proof is mostly made of, so that is where the real codec went.

---

## D-L6-7 — The resampler is an area-average box filter, not Lanczos

**Unsettled by:** the lane brief allows "box/Lanczos filter over decoded pixels".

**Decision.** Separable area-average (box) resampling on premultiplied alpha,
downscale only.

**Why.** Every resample in this pipeline is a downscale, and for downscaling the
area average is the correct reconstruction: each source pixel contributes
exactly its overlapped area. Lanczos wins when upscaling or resampling by small
ratios, and its ringing is most visible on the flat edges and text of UI
screenshots — the most common specimen image. Premultiplying prevents fully
transparent pixels from bleeding undefined colour into their neighbours, which
is asserted by test.

---

## D-L6-8 — `imageQuality` reduces the palette for PNG, since PNG has no lossy dial

**Unsettled by:** `EmitOptions.imageQuality` is a JPEG-style 0.6/0.75/0.85/0.92
quality, and PNG is lossless.

**Decision.** 0.92 and 0.85 keep truecolour; 0.75 quantises to 256 colours and
0.6 to 64, by deterministic median cut, no dithering.

**Why.** Letting the quality control do nothing for PNG would make the emitter's
size budget (§13) a fiction on exactly the assets that dominate an artifact's
bytes. Median cut is the honest lossy lever a lossless format has, and it is
reported per asset (`notes: ['palette:64']`). Dithering is deliberately absent:
it trades flat regions for noise, and noise is what DEFLATE cannot compress, so
it would cost bytes *and* look worse.

---

## D-L6-9 — Attribute reads delegate to L3; text measurement does not

**Unsettled by:** API.md says a lane imports the other lane's surface; D8 puts
the parser in ingest.

**Decision.** `attrOf` delegates to L3's `attr`, and `buildSpecimen` parses HTML
with L3's `parseHtml`. Text measurement (`textOf`, `textStats`) stays in this
lane.

**Why.** Two lanes must not disagree about what a page *says*, so attributes and
parsing come from one place. But `textContent` from ingest concatenates without
block boundaries — `<div>a</div><div>b</div>` reads "ab" — which would glue
words together and quietly corrupt every link-density ratio and text signature
the classifier computes. `textOf` inserts a break at block-level elements and
skips non-rendered ones. That is a measurement decision, and it belongs with the
measurement.

---

## D-L6-10 — The boilerplate lexicon ignores the element's own tag name

**Unsettled by:** nothing; discovered while calibrating.

**Decision.** `boilerplateSignal` matches against class, id, role, aria-label
and `data-*` — never the tag name. Elements are the landmark signal's business.

**Why.** Counting the tag twice charged an `<article>`'s own `<header>` 0.85 for
being called "header", which is how a byline and a headline got stripped out of
a locale variant during calibration. One kind of evidence, one signal.

---

## D-L6-11 — Boilerplate text does not count as prose

**Unsettled by:** nothing; discovered while calibrating.

**Decision.** The content signal excludes paragraphs and list items whose text
matches the boilerplate lexicon, both from its paragraph count and from its
prose character count.

**Why.** "Enter your email address and an engineer will call within one working
day" and "By submitting this form you agree to our privacy policy" are full
sentences, and counting them as prose is precisely how a lead-capture shell
talks its way into a specimen.

---

## D-L6-12 — The page under analysis is excluded from its own sibling set, and a total strip trips a circuit breaker

**Unsettled by:** §8 says "repeated-across-pages detection when multiple pages
are available" but not what happens when the caller supplies the page itself.

**Decision.** `stripChrome` and `classifyChrome` filter `siblings` by object
identity **and** by content fingerprint (`docFingerprint`), so a re-parsed copy
of the same HTML is excluded too. The exclusion is reported in `notes`, never
silent. Separately, if a classification would leave less than a tenth of the
root's own text standing, the repeated-across-pages signal is dropped and the
page is re-classified without it, reported as `repeat signal disabled: …`.

**What `siblings` accepts:** parsed `DocNode` roots, `RawCapture` objects
(`{doc}`), or `{root}` wrappers — mixed freely. Anything else is ignored.

**Why.** Passing "every page I captured" is the obvious call, and without
exclusion it is catastrophic: every block repeats on itself, the strongest
signal condemns all of them, and the specimen comes back with four blocks and
thirty words. §22.3 frames the risk as under-stripping, but over-stripping is
the same wound the other way — it throws away the prospect's own content, which
is the entire product thesis. Making the obvious call correct beats documenting
a trap, and the circuit breaker means even a forced index cannot empty a
specimen.

---

## D-L6-13 — Chrome stripping is reversible by block position, not by re-parsing

**Unsettled by:** §8 requires restoration; `restoreBlock(specimen, removedEntry)`
in API.md takes a specimen and an entry, with no document in sight.

**Decision.** `buildSpecimen` blockifies the **whole** page once, then partitions
the stream: kept blocks carry their index in the full stream
(`specimen.blockPositions`), and each removed region carries its blocks with
their positions (`specimen.stripped[].positions`). `restoreBlock` merges by
position. `restoreNode`/`restoreNodes` do the same at the tree level, unwinding
in reverse order of removal.

**Why.** A `Specimen` is stored in IndexedDB and emitted into an artifact, so it
cannot hold `DocNode`s — they carry `parent` back-references and would not
survive `JSON.stringify`. Positions make restoration exact, order-independent
and serialisable, and they make the §17.5 assertion checkable: restoring every
stripped block reproduces the block stream of the unstripped page exactly.

---

## D-L6-14 — `Specimen` carries `raw`, `rawOptIn`, `edited` and `stripped` as optional extensions

**Unsettled by:** §8 requires an untouched `raw` copy per specimen and a
per-specimen opt-in before raw HTML reaches a scene; §18.3 requires the artifact
to say when a specimen was edited. The §4 `Specimen` interface has fields for
none of this. (Filed in `docs/disputes/L6-specimen.md`; built against the
contract as written.)

**Decision.** Added as optional fields — `raw: string|null`,
`rawOptIn: {allowed, by, at}`, `edited: boolean`, `editNotes: string[]`,
`stripped[]`, `restored[]`, `blockPositions[]`, `chrome{}`, `kindConfidence`,
`kindEvidence[]`, `localeSignals[]`, `strategy`. `rawFallbackBlocks` returns an
empty list until `rawOptIn.allowed` is true, and only `setRawHtmlOptIn` can set
it — with the identity of the person opting in and the time they did it.
Stripping and restoring chrome never set `edited`; only `markEdited` does.

**Why.** §4 permits optional additions and forbids renaming or retyping. The
alternative — carrying these out of band — would leave the emitter unable to see
that a specimen was edited, which is exactly the honesty law §18.3 states.

---

## D-L6-15 — Media that the page references but ingest never fetched stays visible as a block

**Unsettled by:** nothing; `MediaRef` covers captured assets only.

**Decision.** An `<img>` whose bytes were not captured still produces a `media`
block whose `ref` is the source URL, flagged `unresolved: true`, and
`unresolvedMediaRefs(specimen)` lists them.

**Why.** Dropping the image silently would change the shape of the prospect's
page without saying so. Keeping it means L11 raises `ASSET_MISSING` honestly and
the studio can offer to fetch or upload the file before it becomes a finding.

---

## D-L6-16 — The corpus carries a seventh, adversarial fixture

**Unsettled by:** §17.5 asks for hand-labelled fixture pages; the lane brief
names six.

**Decision.** A seventh page was added: a knowledge-base article *about* cookie
consent, whose content quotes "we use cookies", "accept all" and "manage
preferences" and links to a privacy policy — all of it labelled content.

**Why.** Six happy-path fixtures measure how well a classifier strips furniture;
they do not measure whether it destroys content that resembles furniture. The
adversarial page caught three real false negatives on its first run, which
produced D-L6-11. A corpus that only ever agrees with the implementation is a
number, not a test.

---

## D-L6-17 — Importer-supplied blocks have their media refs rewritten to captured ids

**Unsettled by:** §6.5 has the `.docx`/`.pptx`/PDF importers produce
`ContentBlock[]` directly, and §8 has this lane inline media as data URIs. What
neither says is who reconciles the two namespaces: an importer's `media` block
references its own part name (`word/media/image1.png`, `page001-Im1.png`), while
`captureMedia` mints `md_…` ids.

**Decision.** `buildSpecimen` runs importer-supplied blocks through
`resolveBlockMedia(blocks, media)`, which resolves each `ref` against the
captured assets by exact name, basename, relative form and percent-decoded
form, and rewrites it to the `MediaRef` id. A ref that resolves to nothing keeps
its original value, is flagged `unresolved: true`, and is listed on
`specimen.mediaUnresolved` and by `unresolvedMediaRefs(specimen)`.

**Why.** The §20 critic (F4, severity 1) found that without this, every `.docx`
or PDF containing an image produced a specimen whose image was inlined *and*
unreachable — three severity-1 `ASSET_MISSING` findings from two corpus
documents, which blocks emit outright. The HTML path had always resolved refs
during blockification; the importer path silently did not, and nothing asserted
that a block's `ref` names a `MediaRef` of its own specimen. That assertion now
exists for all three importer paths (`.docx`, PDF, image) in
`test/specimen/media-refs.test.mjs`.

---

## D-L6-18 — Media is deduplicated twice: at capture through a ledger, and after the fact by an explicit pass

**Unsettled by:** §13 requires the emitter to budget aggressively against
`maxBytes`; nothing says who is responsible for the same bytes being inlined
once per specimen.

**Decision.** Two entry points, because a project can arrive either way.

- **`MediaLedger`**, an optional `options.ledger` on `buildSpecimen` /
  `captureMedia`. One ledger per project: the second and later captures of the
  same bytes reuse the first `MediaRef` whole — same id, same data URI — and
  skip the re-encode. It counts `hits` and `bytesSaved`.
- **`dedupeMedia(carriers)`**, a pass over anything shaped
  `{media, blocks}` — specimens and renditions together — for projects whose
  specimens were captured independently. It groups by **inlined data URI**,
  keeps the lexicographically smallest id in each group, rewrites every `media`
  block (including `stripped[].blocks`, so restoring a stripped block cannot
  reintroduce a dead ref) and returns `{carriers, mapping, merged, bytesSaved,
  groups}`.

Grouping is on the data URI, not the source digest, because what costs bytes in
the artifact is what was inlined: two captures of one photograph at different
scales are genuinely two assets. The surviving id is chosen from the ids alone,
so the result does not depend on the order carriers are passed in — §17.6 needs
the same project to dedupe to the same bytes every time. `alt` text and source
names differ per page, so the survivor keeps the first non-empty `alt` and
records the rest in `altVariants`, with `absorbedIds` naming what it replaced;
a merge that quietly dropped a page's alt text would be an invisible content
change (§18.3).

**Why.** The §20 critic (F12) measured 67% of the media payload as byte-identical
duplicates on the fixture corpus — five duplicate groups, 13,428 wasted bytes of
20,142 — which both inflates the artifact and makes §13's degradation report
double-count. On the corpus this collapses 12 `MediaRef`s to 3 distinct sets of
bytes, saving 11,481 of 15,308 bytes. Deduping at capture is the cheaper path
and also avoids redundant PNG encoding; the explicit pass exists because the
studio imports pages on different days and the emitter must be able to fix a
project it did not capture.

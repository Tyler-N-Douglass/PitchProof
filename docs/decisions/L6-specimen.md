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
bytes, saving 15,510 of 20,680 inlined bytes (the figures are inlined bytes
since D-L6-19; they were 11,481 of 15,308 when `bytes` meant the decoded
payload). Deduping at capture is the cheaper path
and also avoids redundant PNG encoding; the explicit pass exists because the
studio imports pages on different days and the emitter must be able to fix a
project it did not capture.

---

## D-L6-19 — `MediaRef.bytes` is what the asset costs the artifact, not the payload inside its data URI

**Unsettled by:** §4 declares `bytes: number` on `MediaRef` with no unit and no
referent. Three quantities have a claim on that name — the file the seller
handed us, the binary payload after §8's downscale and recompress, and the
length of the `dataUri` that payload is inlined as — and they differ by about a
third.

**Decision.** `bytes` is the inlined cost: `utf8Length(ref.dataUri)`. The other
two keep their own optional fields, so nothing was lost and nothing has to be
inferred:

| Field | Measures |
|---|---|
| `sourceBytes` | the file as it arrived, before anything was done to it |
| `decodedBytes` | the binary payload after downscale/recompress — what `parseDataUri().bytes` returns (new; this is what `bytes` used to hold) |
| `bytes` (§4) | `utf8Length(dataUri)` — base64's 4/3 expansion and the `data:…;base64,` preamble included |

`MediaLedger.bytesSaved`, `dedupeMedia`'s `bytesSaved` and each reported
group's `bytes` are therefore inlined bytes too: the saving they report is the
saving §13's budget sees.

**Why.** The §20 critic (F19, severity 3) measured `md_4e16750af08d` declaring
2,673 bytes against a 3,586-byte data URI — a uniform 34% understatement, since
base64 is 4/3 of what it carries. On the corpus proof the six distinct assets
declare 6,892 inlined bytes and carry 5,060 decoded: read the old way, every
size was 36% short.

Three reasons the inlined cost is the right meaning of the frozen field rather
than a new one beside it:

1. A `MediaRef` describes an **inlined** asset — §4's own comment on the
   neighbouring field is "always inlined by emit time". The struct has no field
   for the source at all, so the source cannot be what `bytes` is about.
2. It was already not the seller's file. A 2600px PNG comes back downscaled and
   re-encoded, and the old `bytes` was the re-encoded payload — the size of
   something that exists nowhere except inside a base64 string. Reading `bytes`
   as "the source" would have made `sourceBytes` a duplicate and left the only
   quantity anyone spends unnamed.
3. §13 spends one budget, in the bytes of one file. `budgetAssets` already
   measures each asset as `utf8Length(dataUri)`; making `bytes` the same
   measurement means the number a seller reads and the number the budgeter
   enforces cannot drift, and that is now asserted from both ends.

**Who was reading it.** Four consumers, all understated by a third, all now
correct without a line changing outside this lane:

- `src/ui/panels/specimens.js:124` and `src/ui/inspector.js:86` — the `Media`
  row a seller reads, `n · <size>`, on the panel and the inspector.
- `src/ui/panels/emit.js:206` (`estimateBytes`) — the pre-flight size estimate
  shown against `maxBytes`, the one number in the studio whose whole job is to
  predict the artifact.
- `src/validate/rules.js:103` (`mediaBytes`, feeding `ASSET_OVERSIZE`) — an
  asset within a third of §13's per-asset limit was passing the rule that
  exists to catch it.

The emitter's budgeter never read it: `collectAssets` measures
`utf8Length(dataUri)` itself, which is why nothing was broken at emit time and
why this was worth settling rather than patching.

**Left for other lanes.** Two lines this lane may not touch write or read the
old measure and should follow:

- `src/emit/budget.js:424` (L10) — `applyReplacements` writes
  `bytes: parseDataUri(hit.dataUri).bytes` back onto a `MediaRef` after
  degrading it, which is the payload, so a degraded asset re-acquires the
  understatement. The fix is `utf8Length(hit.dataUri)`, or `hit.bytes`, which
  `degradeAsset` already computes that way.
- `src/validate/rules.js:105` (L11) — `mediaBytes`'s fallback, used when a
  `MediaRef` declares no size, is `parseDataUri(...).bytes`. The primary path
  is now the inlined cost, so the fallback should be `utf8Length(media.dataUri)`
  to match; today the same asset measures differently depending on whether it
  declared a size.

**Testing.** `test/specimen/media-refs.test.mjs` measures every asset of
`buildCorpusProof()` against an oracle the test computes itself — it splits the
URI on the comma, decodes the body with `Buffer.from(body, 'base64')`, checks
the 4-characters-per-3-bytes arithmetic against the padding, and takes the
length with `Buffer.byteLength` — so no `MediaRef` can pass by agreeing with the
function that wrote it. Reverting `bytes` to the payload fails all three F19
tests.

---

## D-L6-20 — A captured `<pre>` is a paragraph whose whitespace is significant, not a `raw` block (finding C8, third instance)

**Unsettled by:** §8 says "never present raw HTML in a scene without a user
opt-in per specimen" and §4's `ContentBlock` union has no preformatted variant.
Reported into this lane by L7 as `D-L7-20`, which called the argument here
"genuinely balanced" — unlike its own two instances, a `<pre>` on the prospect's
page really is the prospect's markup, so `raw` was defensible.

**Decision.** `blocksWithTrace` emits `{type: 'paragraph', text, pre: true}` for
a `<pre>`, not `{type: 'raw', html: '<pre>…</pre>'}`. `pre` is the optional §4
extension `API.md` Part 3b declares. After this change **nothing in this lane
builds markup**: the only `raw` block L6 produces is the one
`rawFallbackBlocks` returns, which is the untouched captured source, behind
§8's per-specimen opt-in, with the identity of whoever opted in recorded on it.

It converted, and the argument turned out not to be balanced. Three things
decided it, in ascending order of how badly they hurt the seller.

**1. There was never any captured markup in that block.** `rawTextOf` already
walked the `<pre>`, discarded every element, skipped the non-rendered ones and
turned `<br>` into a newline, so what it returned was text nodes only — which
the parser had already decoded, so `&lt;` was a `<` character and not an
entity. The `<pre>` wrapper and the re-escaping in `escapeText(text)` were
**this module's markup, built after the prospect's was thrown away**. The block
then travelled to a layout whose job was to strip markup off it and caption it
as the prospect's source. The rule §8 states is about markup a layout must not
trust; there was none here to distrust, and the object being labelled "source
markup" was L6's own string template.

**2. It was the one `raw` block in the system that bypassed §8's gate.** §8's
two sentences are one mechanism: keep the untouched source, and never show it
without a per-specimen opt-in. This lane implements that mechanism in
`rawFallbackBlocks`, and the `<pre>` path went round it — a `raw` block landed
in `specimen.blocks` unconditionally, opt-in or no opt-in, and reached a scene.
It was safe only because L8 flattens every `raw` block defensively. A rule
honoured by accident downstream is not honoured. Reading §8 as *requiring* that
block makes §8 contradict itself.

**3. It made the prospect's own code sample a severity-1 finding that blocks
emit.** `NETWORK_REFERENCE` scans `raw` blocks — correctly, because a raw block
is the one path by which captured markup reaches the artifact verbatim, and a
tracking pixel could ride it. `externalRefsIn` matches a *string*, so it read
the `<pre>`'s escaped text as though it were the markup around it. Three of
four realistic samples tripped it:

| A `<pre>` containing | matched | as |
|---|---|---|
| `&lt;script src="https://cdn…/w.js"&gt;` — an embed snippet | `https://cdn…/w.js` | `src=` attribute |
| `const r = await fetch("/api/v1/quote")` | `fetch(` | network API |
| `.hero { background: url(/img/hero.png) }` | `/img/hero.png` | CSS `url()` |

None of them is a reference. Nothing fetches them; L8 renders the block as a
text node and the emitter's own scanner tokenizes the document, so the escaped
text is a text token and was never a hit there. But at the model level each was
severity 1, and severity 1 stops the emit — so a technical page whose `<pre>`
shows how to call an API could not be turned into a proof at all, and the
remedy the finding printed was *"drop the raw block"*: delete the prospect's
own content to unblock the build. That is the §18.3 wound this lane exists to
avoid, arriving through a rule written to prevent it.

**What the seller sees.** A `<pre>` on a real page is a code sample, a spec
table or a configuration snippet — the prospect wrote it for their reader, and
on a technical page it is often the most convincing material in the proof.
Under the old shape it reached the deck with its whitespace collapsed by
`stripTags`'s `\s+ → ' '`, so an aligned parameter table became one run-on line,
and it arrived under the caption *"Source markup, shown as text"* — the tool
telling the room that the client's deliberate content was incidental page
scaffolding it had to defuse. Both of those are now gone, and the line
structure survives capture exactly: `test/specimen/blocks.test.mjs` renders the
`docs.html` fixture's scripting sample through L8 and finds it verbatim,
newlines included, with no caption and no network finding.

**What this does not fix, and whose it is.** `pre` degrades safely — a layout
that has never heard of it renders a paragraph, which is what the `raw` block
rendered as after `stripTags`, minus a caption that was untrue — so this change
stands on its own. But the *visual* half is L8's: `src/scene/blocks.js` does not
read `pre` yet, so `.pp-p` still lays the text out with `white-space: normal`
and a proportional face, and the newlines that now survive into the artifact
collapse when the browser paints them. Rendering a `pre` paragraph with
`white-space: pre-wrap` and a monospace role, and reporting its wrapping to the
overflow detector, is what turns "no longer mislabelled" into "legible".
Reported to the integrator as a secondary ask, not a coupled one.

**Why not fix the caption instead.** That was the alternative the brief named,
and it is the wrong repair for two of the three reasons above: a kinder caption
does not stop `NETWORK_REFERENCE` from blocking the emit, and it does not put
the block back behind §8's opt-in. It would also have to be a *conditional*
caption — L8 cannot tell a whole-page raw fallback from a synthesized `<pre>`
wrapper by looking at the html — which means the distinction would live in a
string-sniffing branch in another lane instead of in the block type, where it
belongs. The caption is right about what a `raw` block is. The block was wrong.

**Sweep of the rest of the category.** Every place this lane could emit `raw`
was checked, not just the one L7 named. There are two, and after this change
one: `rawFallbackBlocks` (`specimen.js`), which is the genuine article and stays
exactly as it is. No other module in `src/specimen/**` constructs markup at
all — `chrome.js`, `dom.js`, `kind.js`, `locale.js`, `media.js` and the image
path deal in text, nodes and bytes. Importer-supplied blocks (`.docx`, PDF,
image) arrive from L3 and carry no `raw` block either.

**Testing.** `test/specimen/blocks.test.mjs` covers: the block shape and that
it carries no `html` field; entity decoding through a real embed snippet
(`&lt;script src=…&gt;` becomes text, exactly once); nested `<span>`, `<b>`,
`<br>`, `<script>` and `<style>` inside a `<pre>` stripped the way `toBlocks`
strips them everywhere else; the three `externalRefsIn` false positives above,
each asserted to zero; column alignment surviving capture byte for byte; and
the end-to-end path from `docs.html` through `buildSpecimen` and L8's
`renderBlocks` to rendered HTML, asserted verbatim, uncaptioned, and clean
under L10's `scanForNetworkReferences`.

---

## D-L6-21 — Media whose bytes the capture never carried is held out of the block stream and recorded, not emitted as a reference to nothing (finding P6)

**Supersedes D-L6-15**, which decided the opposite and gave the reason that is
still the constraint: *"Dropping the image silently would change the shape of
the prospect's page without saying so."* The operative word turned out to be
**silently**. What changed is not the honesty requirement but where it is
discharged.

**Unsettled by:** §6 requires ingest to "degrade gracefully and never dead-end"
and lists paste as strategy 4 — the route a seller takes when a fetch is
blocked. §8 requires media to be inlined at capture. Neither says what a
`media` block should be when the two meet: markup that references an image, and
no bytes anywhere to inline.

**The defect (CRITIQUE-3 P6, severity 2).** A pasted page has markup and no
assets, so `captureMedia` mints nothing — correct, and never in dispute. But
the `media` **block** survived carrying the source path as its `ref`, and a
`media` block whose ref names no `MediaRef` is L11's `ASSET_MISSING` at
**severity 1**. So §6's own listed fallback produced, by construction, a proof
that could not be emitted: one blocking finding per image per rendition, on a
clean three-page paste. Reproduced from a real paste before the change:

```
mediaRefs 0  mediaBlocks 1  dangling ["/assets/product-hx400.png"]
                            (plus "/assets/logo.svg" inside the stripped header)
```

**Decision.** `buildSpecimen` resolves media refs exactly as before (D-L6-17 —
the F4 rewrite from importer part names to minted ids is untouched, and runs
first). What changes is what happens to a ref that still resolves to nothing:
the block is held **out of** the block stream, and the loss is recorded on
`specimen.mediaOmitted` as

```js
{ id, ref, caption, position, origin: 'blocks'|'stripped', strippedId, reason }
```

with four consequences:

- `unresolvedMediaRefs(specimen)` still names every one of them, so the surface
  the studio and API.md's L6→L11 row already point at did not change shape or
  go quiet — it is now the *complete* answer to "what did not come with this
  page", covering both held-back blocks and any dangling ref left in a stream;
- `specimen.meta['capture.mediaOmitted']` carries the count. `meta` is a
  **frozen** field, so a consumer that has never heard of this lane's optional
  extensions still sees that something was left out;
- `restoreOmittedMedia(specimen, target, supply, options)` is the way back: hand
  it a `MediaRef` or a raw `{name, bytes, mime}` and the block returns to the
  exact position it was taken from, with the caption it was omitted with;
- blocks inside a **stripped** chrome region are treated the same way, because
  `restoreBlock` puts those back into the stream — a logo in a pasted `<nav>`
  would otherwise reintroduce the blocking finding the moment a reviewer opened
  "show everything".

The §8 `raw` copy is untouched and still holds the `<img>`, so the loss is
recoverable from the capture itself even without the record.

**Why the same rule for the importer route, when D-L6-17's case is different.**
It is a fair question and the answer is that the *cases* differ while the
*defect* does not. F4's case was a ref that failed to match bytes that were
present — there, keeping the ref visible was right, because the repair was a
lookup and the bytes were three lines away. P6's case is bytes that were never
captured and, on the paste route, never will be from this capture. But a `.docx`
whose image the extractor could not reach is in P6's case too, not F4's, and it
produced the same un-emittable proof. Splitting the behaviour by *route* would
mean paste emits and `.docx` does not, for one defect with one shape; splitting
it by *whether bytes exist* is the same test in both routes, and it is the test
that runs: resolve first (F4), hold back what still resolves to nothing (P6).
D-L6-15's promise — visible, never silently dropped — is kept in full, and moved
off the one carrier that blocks the emit.

**One thing this tightened rather than loosened.** Holding a block back is only
right when the bytes really are absent, so resolution now runs on **every**
route, not just the importer's. Blockification resolves an `<img src>` by exact
key and basename; `resolveMediaRef`'s ladder also tries the relative and
percent-decoded forms. Before, an `<img src="/img/tube%20bundle.png">` over an
asset named `/img/tube bundle.png` produced a dangling ref on the HTML route —
under D-L6-21 that would have become a *dropped* block, for a defect that is
only a lookup. `resolveBlockMedia` is idempotent, so running it over the HTML
route as well costs nothing and closes the gap between the two ladders. Asserted
in `test/specimen/media-refs.test.mjs`.

**Why not keep the block and let L11 handle it.** Three reasons, in order of
weight. It makes §6's documented fallback unusable, which is the finding. Its
only offered remedy deletes the prospect's own content (see below). And the
finding is not *information*: on a paste, `ASSET_MISSING` fires for every image
on the page, every time, and says only what the seller already knows — they
pasted markup. A severity-1 refusal that is a certainty of the route is not a
check, it is a wall.

**Why not lower the severity.** `ASSET_MISSING` is L11's rule and its severity
is right: a block pointing at nothing *is* a broken image in front of the
client. `test/specimen/paste-media.test.mjs` asserts that the rule still fires,
still at severity 1, on a proof that really does carry such a block —
reconstructing the pre-D-L6-21 shape by hand. If that assertion ever passes for
the wrong reason, the finding was weakened rather than the defect fixed.

**Why this does not set `edited`, and what does.** §18.3's `edited` /
`editNotes` mean *the prospect's content was changed*. An image whose bytes were
never captured was never in what we captured: holding it back is the honest
shape of a degraded capture, not an edit to the page, and claiming otherwise
would put a false statement in the artifact. Restoring one is the content coming
*back*, so that does not set `edited` either. What **is** an edit is the auto-fix
for the finding this removes: L11's `ASSET_MISSING` fixer (`src/validate/autofix.js:141`)
splices a block out of `specimen.blocks` and sets neither field, so a proof
whose hero the seller deleted at the tool's suggestion says nothing about it.
That is a §18.3 violation independent of P6 and it survives this change for
every other route to a dangling ref — reported to the integrator as L11's, with
`markEdited` as the existing route to compliance.

**What the seller sees.** Per image: the source path it was referenced by, the
caption or alt the page gave it, where in the page it stood, and the reason.
Plus a count in `meta`, the untouched `raw` source, and a one-call route to
supply the bytes. What is **not** yet built is the studio surface for it:
`src/ui/services.js` has never called `unresolvedMediaRefs`, so today the record
sits on the specimen and no screen reads it. That is L12's wiring and one
`services.js` passthrough for `restoreOmittedMedia`; reported to the integrator
as a coupled ask, because "visible" is only half-true until a screen shows it.

**Testing.** `test/specimen/paste-media.test.mjs` drives the real paste route —
`importHtmlText` on view-source markup with two `<img>`s and no assets, through
`buildSpecimen` with L3's parser, into a `Proof`, through the real `emit()` with
the built runtime — and asserts: the words and the CTA survive; no media block
is left; both images are named with caption, position and origin (one in
content, one in the stripped header); the count reaches `meta`; `edited` is
false; `raw` still holds the `<img>`; the artifact emits with **no** blocking
finding and no `ASSET_MISSING` of any severity; the hand-reconstructed dangling
block is still refused at severity 1; and a supplied PNG puts the block back
between the heading and the first paragraph, pointing at the bytes, with the
outstanding logo still on the record and the emit still clean.
`test/specimen/media-refs.test.mjs` carries the importer half.

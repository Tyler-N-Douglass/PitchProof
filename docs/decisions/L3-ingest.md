# DECISIONS — L3 Ingest

Judgment calls the spec did not settle, in the rationale style of `DECISIONS.md`.
Nothing here overrides `PITCHPROOF-BUILD-SPEC-v1.0.md`, `API.md`, or the
repository-level decisions D1–D17.

---

## D-L3-1 — The parser always produces `html`, `head` and `body`, but never invents a `tbody`

**Unsettled by:** D8 says the parser produces "a light element tree"; §6 and §8
assume a page can be queried. Nothing says whether the tree is a faithful record
of the source or a normalised document.

**Decision.** `parseHtml` always returns a `#document` root containing an
`html` element with a `head` and a `body`, synthesising them when the source
omits them, and routing head-only elements (`title`, `meta`, `link`, `style`,
`script`, `base`, `noscript`, `template`) into `head` until the first flow
content opens `body`. It does **not** perform the rest of HTML5's tree
construction: no `tbody` is inserted around bare `<tr>`, no adoption agency runs
for mis-nested formatting elements, and no `<p>` is created for a stray `</p>`.

**Why.** The synthesis is load-bearing: L6 strips chrome by asking for `body`,
landmark roles and link density, and L5 reads `head` for `@font-face` links and
icons. A parser that returns "whatever was in the file" would make every one of
those consumers write the same defensive lookup. The omissions are the opposite
case — nothing downstream asks for a `tbody`, `table tr` matches either way, and
implementing the adoption agency algorithm would add a page of code that no
product requirement exercises. Both halves are asserted by test, so the boundary
is documented in behaviour rather than in prose.

---

## D-L3-2 — Self-closing syntax is honoured only in foreign content

**Unsettled by:** D8 lists "self-closing foreign elements" among the shapes to
handle, but not what `<div />` in HTML content should mean.

**Decision.** `/>` closes the element in `svg` and `math` subtrees and on void
elements (where it is redundant). On an HTML element — known or custom — it is
ignored, exactly as HTML5 specifies and as every browser behaves, so
`<div />text</div>` puts `text` inside the div.

**Why.** Templating tools do emit `<div />`, and treating it as self-closing
would produce a *different* tree from the one the prospect's own browser built.
Every specimen is a claim about what a page contains; matching the browser is
the only defensible answer, and the alternative silently disagrees with the
screenshot the seller is looking at.

---

## D-L3-3 — The doctype is a property of the document, not a node

**Unsettled by:** `API.md` declares `DocNode.type` as
`'element' | 'text' | 'comment'`. A doctype is none of those, and D8 requires
doctypes to be handled.

**Decision.** The doctype is recorded as `document.doctype` (a string or `null`)
on the `#document` root and is re-emitted by `serialize`. No node of a fourth
type is ever created.

**Why.** Adding a `'doctype'` member to the declared union would be exactly the
silent contract drift §20.1 asks the critic to catch. A property on the root is
an optional extension, which the lane rules permit, and it keeps every consumer
that switches on `node.type` exhaustive.

---

## D-L3-4 — The selector engine refuses what it does not implement

**Unsettled by:** `API.md` names "tag, `.class`, `#id`, `[attr]`, descendant" as
the minimum. It does not say what should happen for a selector outside the
supported set.

**Decision.** The engine implements rather more than the minimum — `*`, the six
attribute operators with the `i` flag, `>`, `+`, `~`, comma groups, `:not`,
`:is`, `:where`, `:first-child`, `:last-child`, `:only-child`, `:empty`,
`:root` — and throws `SelectorError` for anything else, naming the unsupported
production. `:nth-child(an+b)`, pseudo-elements, namespaces and `:has()` are the
declared gaps.

**Why.** The failure mode of a lenient selector engine is a chrome-stripping
rule that matches nothing and is therefore never noticed: under-stripping
poisons every specimen downstream (§22.3), and it does so silently. A thrown
error during development is cheap; a rule that quietly stopped working is the
defect §22.3 is warning about.

---

## D-L3-5 — The named character reference table is the HTML 4.01 set plus the HTML5 additions that appear in real copy

**Unsettled by:** D8 says "entities" without saying which.

**Decision.** ~250 named references, the HTML5 C1 remap for numeric references,
the legacy semicolon-less forms, and the HTML5 attribute rule that stops
`?x=1&sect=2` from becoming `?x=1§=2`. The full 2231-entry HTML5 table is not
shipped.

**Why.** The missing entries are almost entirely mathematical and typographic
aliases that no marketing page emits, and the table is inlined into a
single-file studio, where every kilobyte competes with the cold-boot budget
(§12). An unknown reference is left verbatim rather than mangled, so the failure
mode is a visible `&nvgt;` rather than wrong text — and a visible artefact is
one a user can report.

---

## D-L3-6 — `capturedAt` is always the injected clock, never a timestamp found inside the container

**Unsettled by:** §6 requires `capturedAt` on everything. HAR files carry
`startedDateTime`, MHTML carries `Date:`, and OOXML and PDF both carry creation
timestamps.

**Decision.** `capturedAt` is `clock()`, always, for every strategy. The
container's own timestamps are preserved in `meta` under namespaced keys
(`har.startedDateTime`, `ooxml.created`, `pdf.created`).

**Why.** `capturedAt` answers "when did PitchProof take this?", which is what
`STALE_CAPTURE` measures at emit (§6, §14). A HAR recorded a year ago and
imported today is a *fresh* capture of *stale* content, and conflating the two
would either hide staleness or invent it. Keeping the source timestamps in
`meta` means nothing is lost, and putting them behind a prefix means no importer
can accidentally shadow a field L6 reads.

---

## D-L3-7 — Assets carry aliases, not one canonical name

**Unsettled by:** `API.md` declares `assets: {name, bytes, mime}[]` without
saying what `name` is relative to. A saved page references `./x_files/a.png`, a
HAR keys the same bytes by absolute URL, and MHTML by `Content-Location`.

**Decision.** `name` is the most specific identifier the container gave
(the path within the drop, the host-plus-path of the URL, the content location),
and an optional `aliases: string[]` carries every other reference that resolves
to the same bytes — the bare filename, the raw `src` attribute, the absolute
URL. `relinkAssets(capture)` is offered separately for a consumer that wants the
document rewritten to the canonical names.

**Why.** L6 resolves media by whatever reference it is holding, which depends on
which container the specimen came from. Aliases make one lookup work for all
three, and adding an optional field is legal where changing `name`'s meaning per
strategy would be a trap. Rewriting is not done at import because §8 requires an
untouched copy of the source HTML.

---

## D-L3-8 — HAR assets attach to the most recent preceding document

**Unsettled by:** §6.3 names `.har` as a strategy. A HAR is a flat request log;
nothing in it authoritatively binds a stylesheet to a page.

**Decision.** Entries are walked in file order. Every 2xx `text/html` entry with
a body starts a new capture; every subsequent asset entry attaches to the most
recent capture, and assets that precede the first document attach to it.
`log.pages`/`pageref` is used for the page title when present, but not for
attachment.

**Why.** It is deterministic, it needs no timing analysis, and it is right for
the case that matters — a seller records one page, or records a short click-path
where the assets of page two genuinely do follow page two's document. Using
`pageref` for attachment would be more principled and less reliable: plenty of
HAR exporters omit it, and a heuristic that works on half the files is worse
than one that works on all of them the same way.

---

## D-L3-9 — Speaker notes go to `meta`; nested bullets are flattened without a marker

**Unsettled by:** §6.5 asks for OOXML text and media. §4's `ContentBlock` has no
member for speaker notes and no nesting in `list`.

**Decision.** `.pptx` speaker notes are written to `meta['slide.<n>.notes']`
rather than becoming blocks. Sub-level bullets are emitted as ordinary list
items, with no indent characters and no injected prefix.

**Why.** Notes are the presenter's private text; turning them into content
blocks would put them on screen in a scene, which is the opposite of what they
are. `meta` keeps them addressable by anything that wants them (a presenter-note
prefill, say) without putting them in the specimen body. The flattening is
governed by §18.3: the prospect's own content is presented unmodified, so
injecting `—` or leading spaces to encode a depth the contract cannot express
would be a modification the artifact would then have to disclose. The depth is
lost; the text is exact. That is the right trade for a proof.

---

## D-L3-10 — Slides are read in presentation order and shapes in reading order

**Unsettled by:** §6.5 does not say how to order a deck's content.

**Decision.** Slide order comes from `p:sldIdLst` in `ppt/presentation.xml`,
never from a filename sort. Within a slide, the title placeholder leads, and the
remaining shapes are ordered by their `a:off` position — top to bottom, then
left to right — with shapes that declare no transform keeping document order at
the end.

**Why.** `slide10.xml` sorts before `slide2.xml`, so a filename sort silently
reorders any deck with ten or more slides. Within a slide the stored order is
z-order, which routinely puts a title after the body it sits above; sorting by
position is what makes the extracted text read the way the slide looks. Both are
asserted by a fixture that is deliberately authored in the wrong order.

---

## D-L3-11 — Only images a page actually draws are extracted, and shared images are extracted once

**Unsettled by:** D9 says to extract embedded images. PDF resource dictionaries
are inherited down the page tree, so "the images in this page's resources" is
not the same question as "the images this page shows".

**Decision.** The page's content stream is scanned for `Do` operators (recursing
into Form XObjects) and only the named image XObjects are extracted. An image
object drawn on several pages produces one asset and a `media` block on each
page that shows it.

**Why.** Without it, a two-page document that shares one resource dictionary
reports every image twice — which is not merely untidy, it doubles the asset
bytes the emitter then has to budget against (§13) and misrepresents what is on
each page. Both halves are asserted against the fixture, whose second page
inherits the resources and draws nothing.

---

## D-L3-12 — PDF text structure is inferred from geometry and relative type size

**Unsettled by:** D9 says to extract text. It does not say what structure that
text should have, and §4 requires `ContentBlock[]`, which has headings, lists
and paragraphs.

**Decision.** Word breaks come from the horizontal gap between positioned runs
(wider than 0.18 em inserts a space); line breaks from the baseline; paragraph
breaks from vertical rhythm, indentation change and terminal punctuation;
hyphenation at a line break is repaired. A line is promoted to a heading when
its type size exceeds the page's *modal* size — weighted by how much text is set
in each size — by more than 14%, with the level following the rank of distinct
sizes. Lines that repeat verbatim at the same vertical position on 60% or more
of the pages are dropped as running heads.

**Why.** A PDF contains no spaces, no paragraphs and no headings; it contains
glyph placements. Any structure is inferred, so the only question is whether the
inference is principled. Relative size is the one signal that survives every
document design — absolute thresholds break on the first deck set in 9pt or the
first report set in 14pt — and weighting the modal size by text volume stops a
single large headline from redefining "body". Every threshold here is a constant
in one place with a test that pins its behaviour.

---

## D-L3-13 — Standard-14 fonts are measured through `core/text-metrics.js`

**Unsettled by:** D9 requires honouring encodings; it says nothing about advance
widths, which the text extractor needs in order to know where a run ends.

**Decision.** Widths come from the font's `/Widths` or `/W` array when present.
When a font declares none — which is legal for the standard 14 — the advance is
taken from `core/text-metrics.js` (`metricsFor` + `advanceOfString`), the same
published AFM tables the rest of the product measures with (D7).

**Why.** D7 already established that one measurement service serves the whole
product so that rehearsal, CI and the studio cannot disagree. Inventing a second
width source inside the PDF importer would reintroduce exactly the divergence D7
removed, and a wrong advance shows up as missing or spurious spaces in extracted
copy — the most visible possible defect in a specimen.

---

## D-L3-14 — Extracted bitmaps are re-encoded with the in-repo compressor

**Unsettled by:** D9 says `FlateDecode` bitmaps are "re-encoded"; it does not say
by what.

**Decision.** Raw samples are converted to 8-bit RGB (gray, RGB, CMYK, ICCBased,
Indexed, and 1-bit stencil masks are all handled), composed with an `/SMask`
into RGBA when one is present, and written as a PNG whose `IDAT` is produced by
`core/deflate.js` (D5) and whose CRCs come from `core/zip.js`.

**Why.** Reusing the repo's own compressor makes the extracted bytes
reproducible, which keeps the §17.6 byte-identical re-emit assertion true for
any proof built from a PDF. Carrying the soft mask matters specifically for
logos: a logo that loses its transparency is a logo L5 cannot place on a dark
surface, and the brand system is the thing the whole proof is built on.
Filters this repo does not decode (`JPXDecode`, `CCITTFaxDecode`, `JBIG2Decode`)
are counted and named in `meta` rather than guessed at — §18.5 forbids implying
a capability that was not performed.

---

## D-L3-15 — Sitemap ranking is diversified, and freshness is relative

**Unsettled by:** §6 says to rank by structural richness and names the four
kinds of page a good suggestion set contains. It does not say whether "rank"
means one ordered list or a covering set.

**Decision.** Every entry is scored on structural signals — slug specificity,
path depth, declared `hreflang` alternates, relative freshness, and lightly
weighted self-declarations — with penalties for pagination, tag and search URLs,
query strings and non-HTML targets. Entries are then bucketed by kind and
emitted round-robin in §6's order (home, product, article, locale, category,
other), so the head of the list covers one of each before offering a second of
anything. Freshness is computed by ranking each `lastmod` against the other
entries in the same sitemap; no clock is read.

**Why.** A pure score ordering on a real site returns four articles, because
articles have the wordiest slugs — and four articles is a worse starting set
than four different kinds of page, which is precisely why §6 enumerates the
four. Round-robin makes the spec's sentence a property of the algorithm rather
than a hope. Relative freshness keeps §5's determinism law intact while still
answering the question that matters ("which of these is the newest?"), and it
means the ranking of a fixed sitemap is stable forever rather than drifting with
the calendar.

---

## D-L3-16 — Three proxy URL shapes, and no default

**Unsettled by:** §6.2 says the user pastes "a proxy base URL they trust" and
that no third-party proxy is ever shipped. It does not say how a base becomes a
request URL.

**Decision.** `{url}` (percent-encoded substitution), `{rawurl}` (verbatim
substitution), a base ending in `=`, `?` or `&` (encoded append), or anything
else (path append) — covering every self-hosted proxy shape in common use. The
default is the empty string, and a test asserts that no `http` URL appears
anywhere in the strategy table.

**Why.** Getting this wrong means the one escape hatch a seller has does not
work, and they have no way to tell why. Accepting all four shapes costs six
lines. The test on the strategy table turns §6.2's prohibition into something a
machine checks on every run, which is the standard the rest of this repo holds
its laws to.

---

## D-L3-17 — Files are dispatched on their bytes, and failure messages never echo internals

**Unsettled by:** §6.5 lists the file types. Nothing says what to do with a
`.docx` that is really a PDF, and §6.1's "do not surface a scary error as the
primary experience" is a direction rather than a rule.

**Decision.** `ingestFile` sniffs magic bytes and routes on those, using the
filename only as a fallback. Every failure returns a `Result` whose message
names what happened and what to try next; a test asserts that no message
contains a stack frame, `undefined`, `[object Object]`, `NaN` or a `TypeError:`
prefix, and that every message reads as a sentence.

**Why.** Both are about the same twenty minutes: a seller preparing for a pitch
who dropped the wrong file, or whose prospect's site is behind a bot wall. The
tool's job in that moment is to keep moving. Sniffing means a mislabelled file
still imports; the message rule means the thing they read is a next step rather
than a diagnostic written for the person who wrote the parser.

---

## D-L3-18 — Pasted plain text is accepted, not refused

**Unsettled by:** `API.md` declares `importHtmlText(html, …)`. §6.4 calls the
strategy "Paste HTML".

**Decision.** Text containing no markup at all is wrapped into paragraphs, run
through the manual-entry block parser, and flagged `meta['paste.wrapped']`. Only
an empty paste is refused.

**Why.** §6's governing law is that ingest never dead-ends. A paste surface that
rejects a paste because the user copied rendered text instead of source is a
dead end, and it is a dead end at the exact moment the user has already been
through four failing strategies. The flag keeps the provenance honest.

---

## D-L3-19 — The lane owns a small XML reader rather than extending `core/zip.js`

**Unsettled by:** §19 gives each lane its own directory and forbids editing
another's files. `core/zip.js` provides `parseXmlAttrs` and `xmlText`, which are
regex-level and not enough for OOXML.

**Decision.** `src/ingest/xml.js` is a proper XML tree reader used by the `.docx`
and `.pptx` importers. `core/zip.js` is used unchanged for the container,
relationships and part MIME types.

**Why.** Paragraph structure in both formats lives in nesting — `w:p > w:r > w:t`,
`p:sp > p:txBody > a:p > a:r > a:t` — and a regex over that produces
plausible-looking wrong answers, which is the worst failure mode for a specimen.
Adding the reader to `core` would have meant editing another lane's directory,
which §19 forbids; putting it in this lane costs a hundred and fifty lines and
is exported from `src/ingest/index.js` so L6 can reuse it rather than write a
third one.

---

## D-L3-20 — Ranked sitemap entries and strategies are data, not calls

**Unsettled by:** `API.md` declares `fetchStrategies(): Strategy[]` without
declaring `Strategy`.

**Decision.** A `Strategy` is a plain record — `id`, `order`, `specOrder`,
`label`, `describe`, `kind`, `automatic`, `accepts`, `requires` — plus an
executable `run(input, deps)`. `specOrder` maps each strategy back to the §6
numbered strategy it belongs to, so the three archive formats declare themselves
as three implementations of §6.3.

**Why.** L12 has to render this list, explain each route to a user who has just
watched two of them fail, and dispatch a file drop to the right one. Making the
table both descriptive and executable means the studio's ordering and the
lane's ordering cannot drift apart, and `specOrder` keeps the §6 numbering
visible in the code rather than only in the spec.

/**
 * L3 Ingest — the surface declared in `API.md` Part 3.
 *
 * §6's law is that ingest degrades gracefully and never dead-ends. That shape
 * is visible here: eight strategies in the spec's order, each independently
 * useful, each returning a `Result` rather than throwing, and the last of them
 * — typing it in by hand — always available and impossible to block.
 *
 * Two injections make the lane testable and keep it inside the product's laws:
 * `http` is passed in, so nothing here touches a global network API, and
 * `clock` is passed in, so every `capturedAt` is deterministic (§5).
 *
 * @module ingest
 */

// The parser and the query engine (D8).
export {
  parseHtml, parseFragment, tokenize, walk, textContent, normalizedText, attr, hasAttr,
  childElements, firstElement, elementsByTag, classList, ancestors, nodePath, plainTree,
  serialize, createElement, appendChild, isKnownHtmlElement,
  VOID_ELEMENTS, RAW_TEXT_ELEMENTS, ESCAPABLE_RAW_TEXT_ELEMENTS, HEAD_ELEMENTS,
} from './html-parse.js';

export {
  querySelectorAll, querySelector, matches, closest, parseSelector, matchesComplex, SelectorError,
} from './select.js';

export { decodeEntities, escapeHtml, NAMED_ENTITIES, LEGACY_ENTITIES } from './entities.js';

// Captures and the services every strategy shares.
export {
  makeCapture, htmlCapture, documentMeta, documentReferences, now,
  resolveUrl, originOf, pathOf, normalizeAssetRef,
  mimeForName, sniffMime, asciiHead, toDataUri, imageSize, ClockRequiredError,
} from './capture.js';

// Strategies 1 and 2 — network, through an injected transport.
export {
  fetchStrategies, strategyById, nextStepsMessage, proxyUrl,
  fetchDirect, fetchViaProxy, ingestUrl, ingestFile, ingestFiles, attachSubresources,
} from './fetch.js';

// Sub-resource collection: the stylesheet, logo and media a captured document
// references, fetched through the same injected transport (§7, §8).
export {
  collectSubresources, subresourceCandidates, cssReferences, pickFromSrcset,
  candidateAllowed, sameSite, applySubresourceReport,
  SUBRESOURCE_LIMITS, SRCSET_TARGET_WIDTH, ROLE_ORDER,
} from './subresources.js';
export { parseRobots, robotsAllows, groupFor, ruleMatches, emptyRobots } from './robots.js';

// Strategy 3 — saved page, HAR, MHTML.
export { importSavedPage, relinkAssets, joinPath } from './saved-page.js';
export { importHar, decodeContent } from './har.js';
export {
  importMhtml, parseHeaders, headerParam, decodeQuotedPrintable, decodePartBytes, decodeWithCharset,
} from './mhtml.js';

// Strategies 4 and 6 — paste and manual entry.
export { importHtmlText, importManual, parseTextBlocks } from './paste.js';

// Strategy 5 — file import.
export {
  importOoxml, headingLevelForStyle, docxParagraphContent, pptxParagraph, slideOrder, coreProperties,
} from './ooxml.js';
export { importPdf } from './pdf/index.js';
export { importImage, importPageImages, titleFromFilename, assetDataUri } from './image.js';

// Sitemap assist.
export {
  discoverSitemap, rankCandidates, parseSitemap, makeEntry, classify, scoreEntry,
  topSuggestions, gunzip, KIND_PRIORITY,
} from './sitemap.js';

// The XML reader the OOXML importers are built on; L6 may reuse it.
export { parseXml, walkXml, findAll, findFirst, childNamed, childrenNamed, xmlAttr, xmlTextOf } from './xml.js';

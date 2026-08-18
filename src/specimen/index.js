/**
 * L6 Specimen — the lane surface declared in `API.md` Part 3.
 *
 *   stripChrome(doc, {siblings?}): {root, removed: {node, reason, score}[]}
 *   toBlocks(root, {media}): ContentBlock[]
 *   captureMedia(assets, {imageQuality, maxEdge, idMinter}): MediaRef[]
 *   detectLocale(doc, url): string|null
 *   buildSpecimen(capture, {kind?, imageQuality, clock, idMinter}): Specimen
 *   restoreBlock(specimen, removedEntry): Specimen
 *
 * Everything else exported here is a lane extension: additional exports are
 * explicitly allowed, and these are the ones the studio (L12), the recipe lane
 * (L7) and the emitter (L10) need in order to show a reviewer *why* a block was
 * removed, to put it back, and to know which media could not be downscaled.
 */

export {
  stripChrome, restoreNode, classifyChrome, locateMainRoot, siblingIndex,
  scoreBlock, landmarkSignal, linkSignal, boilerplateSignal, repeatSignal,
  contentSignal, textSignature, structSignature, distinctiveStruct,
  dropNonRendered, CHROME_THRESHOLD, CHROME_LEXICON, CHROME_PHRASES,
} from './chrome.js';

export {
  toBlocks, blocksWithTrace, mediaIndex, splitOnBreaks, isEmptyBlock,
  repairHeadingLevels, unrepairHeadingLevels,
} from './blocks.js';

export {
  captureMedia, toDataUri, paletteFor, MAX_EDGE, RESIZABLE_FORMATS,
} from './media.js';

export { imageInfo, jpegSize, webpSize, svgSize, mimeForFormat } from './imageinfo.js';
export { decodePng, encodePng, pngSize, pngChunks, isPng, adler32, PNG_SIGNATURE } from './png.js';
export { resizeRgba, fitWithin } from './resample.js';
export { medianCut } from './quantize.js';

export { detectLocale, localeSignals, normalizeLocale, urlSignals, LOCALE_SIGNAL_RANK } from './locale.js';
export { inferKind, inferKindWithEvidence, schemaTypes } from './kind.js';

export {
  buildSpecimen, restoreBlock, restoreAllBlocks, extractMeta,
  setRawHtmlOptIn, rawFallbackBlocks, markEdited,
  repairHeadings, unrepairHeadings, unresolvedMediaRefs,
} from './specimen.js';

export {
  attrOf, textOf, textStats, tagOf, elements, byTag, cloneTree, linkParents,
  bodyOf, headOf, selectorPath, normalizeSpace, identityString,
} from './dom.js';

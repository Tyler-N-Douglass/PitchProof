/**
 * L10 Emitter — the lane's public surface (API.md, Part 3).
 *
 * ```
 * emit(proof, options, deps): Promise<Result<EmitResult>>
 * scanForNetworkReferences(html): Finding[]
 * assertProvenance(proof, html, css): Finding[]   // §18.1 and §18.3, one walk
 * budgetAssets(proof, maxBytes): {plan: DegradationLine[], proof: Proof}
 * inlineRuntime({runtimeJs, runtimeCss, themeCss, proof, firstPaintHtml}): string
 * ```
 *
 * Everything below the four declared entry points is exported as well, because
 * `scripts/verify-offline.mjs` and the lane's own tests need to reach the
 * pieces individually — but no other lane may depend on them.
 *
 * **There is no override flag anywhere in this module or anything it imports.**
 * A severity-1 finding refuses the emit, and the refusal comes back as `err`
 * carrying every blocking finding (§14). `test/emit/no-override.test.mjs`
 * searches the whole repository to keep that true.
 *
 * @module emit/index
 */

export { emit, buildDocument, layoutsMissingFor, staleCaptureFindings, stripPresenterNotes, describeRefusal, STALE_CAPTURE_DAYS } from './emit.js';

export { runEmitGate, gatedCodes, MEASURED_BY_EMIT } from './gate.js';

export {
  scanForNetworkReferences, scanModelAssets, scanForeignScripts, scanCss, scanJs,
  scanAbsoluteUrls, scanNestedDataUri,
  classifyUrl, isW3cNamespace, parseSrcset, networkFinding,
  W3C_NAMESPACES, URL_ALLOWLIST, URL_ATTRS, SRCSET_ATTRS, TEXT_ATTRS, JS_NETWORK_TOKENS, EMITTED_SCRIPTS,
} from './scan.js';

export {
  assertProvenance, judgeLabelStyle, judgeLabelRoom, clipsContent, scaleFactorOf,
  resolveBackground, describeElement, walkWithChain, renditionAppearsIn,
  documentChainPrefix, allScenesOf, nodeText, provenanceFinding, labelOptionFinding,
  glyphPaint, parseFilter, editedScenesOf, htmlHasClass, markerFor,
  PROVENANCE_LABEL_CLASS, EDITED_MARK_CLASS, MIN_LABEL_FONT_PX, LABEL_MIN_WIDTH_EM,
  LABEL_MIN_TRACKING_EM, LABEL_MAX_BLUR_EM, RENDITION_ATTR, SPECIMEN_ATTR, EDITED_FOR_ATTR,
  PROTECTED_MARKERS, LABEL_MARKER, EDITED_MARKER,
} from './provenance.js';

export {
  promotionRecord, hasPromotionRecord, requiresProvenanceLabel, isUnearnedVerification,
} from './promotion.js';

export {
  budgetAssets, collectAssets, dedupeAssets, rankAssets, locateAssets, degradeAsset, minifySvg,
  applyReplacements, beatIndexResolver, sizeBudgetFinding, predictEmittedBytes,
  countAssetCopies, assetFootprint,
  dataUriPrefixBytes, scaleForQuality, quantizeScale, scaleSteps, describeFixedCost,
  SCALE_FLOOR, SCALE_QUANTUM, IMPORTANCE_SPREAD, MEASURED_PROBES, PNG_CONTAINER_BYTES,
} from './budget.js';

export {
  inlineRuntime, documentLanguage, jsonForScript,
  STAGE_ROOT_ID, PRERENDERED_ATTR, MODEL_ELEMENT_ID, MEDIA_ELEMENT_ID, INERT_SCRIPT_TYPE,
} from './document.js';

export {
  encodePayload, splitMedia, isExtractableMedia, hoistFirstPaintMedia,
  MEDIA_PLACEHOLDER_FLOOR, MEDIA_REF_ATTR, HOISTABLE_ATTRS,
} from './model.js';

export {
  ppBase64ToBytes, ppInflateRaw, ppUtf8Decode, ppReadMediaTable, ppRehydrateMedia, ppDecodePayload,
  ppDecodePayloadRaw, ppBootArtifact, artifactRuntimeSource,
} from './artifact-runtime.js';

export { compileFallbackTheme, compileFontFaces, quoteFamily, stackFor, ROLE_VARS } from './theme.js';

export {
  parseStylesheet, parseSelector, parseDeclarations, computeCascade, matchesSelector,
  specificityOf, resolveVars, resolveFontSize, resolveLengthPx, resolveLineHeightPx,
  splitTopLevel, parseOpacity, backgroundColorOf,
  conditionsApply, splitSelectorList, TRACKED_PROPS, INHERITED_PROPS,
} from './css.js';

export {
  parseColor, contrastRatio, relativeLuminance, compositeOver, oklabToSrgb, oklchToSrgb,
  hslToRgb, hwbToRgb, splitArgs, splitComponents, parseColorMix, NAMED_COLORS,
} from './color-value.js';

export { tokenizeHtml, maskJs, maskCss, lineColOf, excerptAt, decodeEntities, RAW_TEXT_TAGS, VOID_TAGS } from './scan-parse.js';

export {
  decodePng, encodePng, rescalePng, resample, pngSize, isPng, readChunks, adler32,
} from './png.js';

/**
 * @typedef {object} EmitResult
 * @property {string} html
 * @property {number} bytes
 * @property {import('../core/contracts.d.ts').Finding[]} findings
 * @property {import('./budget.js').DegradationLine[]} degradations
 * @property {{mode: 'deflate'|'raw', modelBytes: number, mediaBytes: number}} compression
 */

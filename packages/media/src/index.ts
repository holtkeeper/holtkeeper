export {
  type Artifact,
  type CodeChange,
  type Edit,
  type Range,
  changeItem,
  codeChangeSchema,
  editSchema,
  positionAt,
  rangeOf,
  replaceFile,
} from './changes.ts'
export {
  type EncodeOptions,
  type EncodeResult,
  encodeVariants,
  sha256Hex,
  variantCacheKey,
} from './encode.ts'
export {
  type InlineSvgFinding,
  type InlineSvgOptions,
  type InlineSyntax,
  inlineSyntaxOf,
  optimizeInlineSvgs,
  optimizePathData,
} from './inline.ts'
export {
  type PlanOptions,
  defaultQuality,
  defaultWidths,
  originalOutput,
  planVariants,
} from './plan.ts'
export {
  countColors,
  isSrgbProfile,
  loadSharp,
  probeImage,
  requireSharp,
  sharpAvailable,
} from './probe.ts'
export {
  type FormatSavings,
  type SavingsSummary,
  type SavingsUsage,
  type SavingsVariant,
  type ViewportPick,
  type ViewportTransfer,
  savingsMarkdown,
  savingsSummary,
} from './savings.ts'
export {
  type NamingScheme,
  type Snippet,
  type SnippetFramework,
  type SnippetOptions,
  type SnippetVariant,
  formatOfFile,
  imageSetValue,
  pictureSnippets,
  snippetFrameworks,
  variantFile,
} from './snippets.ts'
export { ssim } from './ssim.ts'
export {
  type PathStats,
  type SvgBreakdown,
  type SvgIssue,
  type SvgOptimization,
  type SvgOptimizeOptions,
  type SvgPreset,
  optimizeSvg,
  pathStats,
  scanTags,
} from './svg.ts'
export {
  type EncodeFailure,
  type EncodedVariant,
  type ImageInfo,
  type ImageUsage,
  type OutputFormat,
  type SkippedFormat,
  type VariantCache,
  type VariantPlan,
  type VariantSpec,
  outputFormats,
} from './types.ts'

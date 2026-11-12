import { type MediaVariantsInput, type MediaVariantsResult, formatBytes } from '@holtkeeper/api'

/** Output formats the media engine encodes; none selected means its own choice. */
export const mediaFormats = ['avif', 'webp', 'png', 'jpeg'] as const

/** Encoder effort presets. */
export const mediaPresets = ['fast', 'default', 'max'] as const

/** Checks one width entry: a whole number of pixels from 1 to 8192. */
export function validateWidth(value: string): string | undefined {
  const width = Number(value)
  return Number.isInteger(width) && width > 0 && width <= 8192
    ? undefined
    : 'A whole number of pixels up to 8192'
}

/** Checks one density entry: a factor above 0 and at most 4 (`2`, `1.5`). */
export function validateDensity(value: string): string | undefined {
  const density = Number(value.replace(/x$/i, ''))
  return Number.isFinite(density) && density > 0 && density <= 4
    ? undefined
    : 'A factor above 0 and up to 4'
}

/** Checks the quality field: empty, or a whole number from 1 to 100. */
export function validateQuality(value: string): string | undefined {
  if (!value.trim()) return undefined
  const quality = Number(value)
  return Number.isInteger(quality) && quality >= 1 && quality <= 100
    ? undefined
    : 'A whole number from 1 to 100'
}

/** Sorted, de-duplicated numbers of valid entries; `2x` reads as `2`. */
export function parseNumbers(values: readonly string[]): number[] {
  const numbers = values
    .map((value) => Number(value.trim().replace(/x$/i, '')))
    .filter((n) => Number.isFinite(n) && n > 0)
  return [...new Set(numbers)].toSorted((a, b) => a - b)
}

/** What the media form edits. */
export interface MediaDraft {
  file: string
  ref: string
  formats: string[]
  widths: string[]
  densities: string[]
  quality: string
  preset: string
}

export const emptyMediaDraft: MediaDraft = {
  file: '',
  ref: '',
  formats: [],
  widths: [],
  densities: [],
  quality: '',
  preset: 'default',
}

/** Errors of a draft by field; empty when it can be sent. */
export function validateMediaDraft(draft: MediaDraft): Partial<Record<keyof MediaDraft, string>> {
  const errors: Partial<Record<keyof MediaDraft, string>> = {}
  const file = draft.file.trim()
  if (!file) errors.file = 'Enter the image path in the repository'
  else if (file.startsWith('/')) errors.file = 'Relative to the repository root, no leading "/"'
  const quality = validateQuality(draft.quality)
  if (quality) errors.quality = quality
  return errors
}

/** The request body for a draft; empty fields are left to the server's defaults. */
export function toVariantsInput(repo: string, draft: MediaDraft): MediaVariantsInput {
  const widths = parseNumbers(draft.widths)
  const densities = parseNumbers(draft.densities)
  const ref = draft.ref.trim()
  return {
    repo,
    file: draft.file.trim(),
    ...(ref ? { ref } : {}),
    ...(draft.formats.length ? { formats: draft.formats } : {}),
    ...(widths.length ? { widths } : {}),
    ...(densities.length ? { densities } : {}),
    ...(draft.quality.trim() ? { quality: Number(draft.quality) } : {}),
    ...(draft.preset && draft.preset !== 'default' ? { preset: draft.preset } : {}),
  }
}

/** Chip tone of a saving: large, some, none, or a larger file. */
export function savingsTone(percent: number): 'success' | 'accent' | 'default' | 'danger' {
  if (percent < 0) return 'danger'
  if (percent >= 30) return 'success'
  if (percent > 0) return 'accent'
  return 'default'
}

/** `-42%` for a smaller file, `+8%` for a larger one. */
export function formatSavings(percent: number): string {
  const rounded = Math.round(percent)
  if (rounded === 0) return '0%'
  return rounded > 0 ? `-${rounded}%` : `+${-rounded}%`
}

const snippetLabels: Record<string, string> = {
  html: 'HTML',
  react: 'React',
  jsx: 'JSX',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  angular: 'Angular',
  nextjs: 'Next.js',
  next: 'Next.js',
  markdown: 'Markdown',
  css: 'CSS',
}

/** Tab label of a snippet framework key. */
export const snippetLabel = (key: string): string =>
  snippetLabels[key] ?? key.charAt(0).toUpperCase() + key.slice(1)

/** Repository paths chosen more than once, which would overwrite each other. */
export function duplicatePaths(paths: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const path of paths.map((p) => p.trim())) {
    if (seen.has(path)) duplicates.add(path)
    seen.add(path)
  }
  return duplicates
}

/** The optimizer's steps in order. */
export const mediaSteps = [
  { id: 'configure', label: 'Configure' },
  { id: 'variants', label: 'Choose variants' },
  { id: 'markup', label: 'Markup' },
  { id: 'deliver', label: 'Merge request or ZIP' },
] as const

/** Id of one optimizer step. */
export type MediaStep = (typeof mediaSteps)[number]['id']

/** Whether `step` is behind, at or ahead of `current`. */
export function stepState(step: MediaStep, current: MediaStep): 'done' | 'current' | 'todo' {
  const at = mediaSteps.findIndex((s) => s.id === current)
  const index = mediaSteps.findIndex((s) => s.id === step)
  return index < at ? 'done' : index === at ? 'current' : 'todo'
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A sent draft as labelled lines for the collapsed Configure step. */
export function configSummary(draft: MediaDraft): { label: string; value: string }[] {
  const widths = parseNumbers(draft.widths)
  const densities = parseNumbers(draft.densities)
  const preset = (mediaPresets as readonly string[]).includes(draft.preset)
    ? draft.preset
    : 'default'
  const quality = draft.quality.trim()
    ? `q${Number(draft.quality)}`
    : 'tuned (AVIF 55, WebP and JPEG 78)'
  return [
    {
      label: 'Formats',
      value: draft.formats.length
        ? draft.formats.map((format) => format.toUpperCase()).join(', ')
        : 'AVIF, WebP and the source format',
    },
    {
      label: 'Widths',
      value: widths.length ? `${widths.join(', ')} px` : 'responsive ladder up to the source width',
    },
    {
      label: 'Densities',
      value: densities.length ? densities.map((d) => `@${d}x`).join(', ') : 'none',
    },
    { label: 'Effort · quality', value: `${capitalize(preset)} · ${quality}` },
    { label: 'Read from', value: draft.ref.trim() || 'default branch' },
  ]
}

/**
 * The artifact that can replace the original file: the optimized SVG, else a variant generated at
 * the original's own path (the re-encoded original).
 */
export function replacementOf(result: MediaVariantsResult, file: string): string | undefined {
  if (result.svg) return result.svg.id
  return result.variants.find((variant) => variant.path === file.trim())?.id
}

/** Variants offered as new files: every variant except the replacement of the original. */
export const offeredVariants = (
  result: MediaVariantsResult,
  file: string,
): MediaVariantsResult['variants'] => {
  const replacement = replacementOf(result, file)
  return result.variants.filter((variant) => variant.id !== replacement)
}

/** Variants chosen at first: every offered one whose suggested path does not exist yet. */
export const initialSelection = (result: MediaVariantsResult, file: string): string[] =>
  offeredVariants(result, file)
    .filter((variant) => !result.exists[variant.path])
    .map((variant) => variant.id)

/**
 * Chosen variants that would overwrite a file at the ref: the path is still the suggested one and
 * the server reported it as existing. Edited paths are checked when the merge request opens.
 */
export function conflictIds(
  result: MediaVariantsResult,
  selected: readonly string[],
  paths: Readonly<Record<string, string>>,
): string[] {
  return result.variants
    .filter(
      (variant) =>
        selected.includes(variant.id) &&
        (paths[variant.id] ?? variant.path).trim() === variant.path &&
        result.exists[variant.path] === true,
    )
    .map((variant) => variant.id)
}

/** The error under a variant's path field, or nothing when it can be written. */
export function pathError(
  path: string,
  { duplicate, exists, ref }: { duplicate: boolean; exists: boolean; ref: string },
): string | undefined {
  if (!path.trim()) return 'Enter a path'
  if (duplicate) return 'Another variant uses this path'
  if (exists) return `Already exists on ${ref.trim() || 'the default branch'}`
  return undefined
}

/** "5 of 7 chosen, 1.2 MB added" for the variants step. */
export function selectionText(
  offered: readonly { id: string; bytes: number }[],
  selected: readonly string[],
): string {
  const chosen = offered.filter((variant) => selected.includes(variant.id))
  const bytes = chosen.reduce((total, variant) => total + variant.bytes, 0)
  return `${chosen.length} of ${offered.length} chosen${chosen.length ? `, ${formatBytes(bytes)} added` : ''}`
}

/** Why the variants cannot be delivered yet, or nothing when they can. */
export function deliverBlocker({
  chosen,
  replace,
  emptyPaths,
  duplicates,
  conflicts,
}: {
  chosen: number
  replace: boolean
  emptyPaths: number
  duplicates: number
  conflicts: number
}): string | undefined {
  if (!chosen && !replace) return 'Choose a variant or replace the original'
  if (emptyPaths) return 'Enter a path for every chosen variant'
  if (duplicates) return 'Give every chosen variant its own path'
  if (conflicts)
    return `Fix ${conflicts === 1 ? '1 conflict' : `${conflicts} conflicts`} to continue`
  return undefined
}

/** Default merge request title for a file: "Optimize hero.png". */
export const mediaTitle = (file: string): string =>
  `Optimize ${file.trim().split('/').at(-1) || 'image'}`

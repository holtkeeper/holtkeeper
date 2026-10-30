import type { MediaVariantsInput } from '@holtkeeper/api'

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

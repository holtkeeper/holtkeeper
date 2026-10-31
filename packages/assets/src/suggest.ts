import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'

import type { Asset, Suggestion, SuggestionRule } from './data.ts'

/**
 * Conservative size ratios (converted / original) used when savings are estimated. Each is at
 * the cautious end of published comparisons, so real conversions usually save more:
 * - `opaque-png` 0.6: lossy WebP q80 of opaque PNGs; photos shrink far more, flat art less.
 * - `alpha-png` 0.75: lossless WebP is ~26% smaller than PNG (Google's WebP lossless study).
 * - `jpeg` 0.7: AVIF at similar quality is commonly 30–50% smaller than JPEG.
 * - `jpeg-webp` 0.8: lossy WebP is 25–34% smaller than JPEG at equal SSIM (Google's WebP study).
 * - `animated-gif` 0.8: lossless animated WebP is ~19% smaller than GIF (lossy saves ~64%).
 * - `desktop-font` 0.6: WOFF2 (Brotli + glyph transforms) is typically 40–60% below raw TTF/OTF.
 * - `uncompressed-audio` 0.12 / 0.2: Vorbis q4 (~128 kbit/s) against 16-bit stereo PCM
 *   (1411 kbit/s) or FLAC (~650 kbit/s), used only when the duration is unknown.
 */
export const estimateRatios = {
  'opaque-png': 0.6,
  'alpha-png': 0.75,
  jpeg: 0.7,
  'jpeg-webp': 0.8,
  'animated-gif': 0.8,
  'desktop-font': 0.6,
  'uncompressed-pcm': 0.12,
  'uncompressed-flac': 0.2,
} as const

/** Bitrate assumed for Vorbis q4 when the duration of a WAV or FLAC is known. */
export const VORBIS_Q4_BITRATE = 128_000

export interface Converter {
  tool: string
  /** Extension of the output file. */
  output: string
  /** Command converting `input` to `output`; both are paths in a temporary directory. */
  command(input: string, output: string): string[]
  /** Path the tool writes to when it picks the name itself. */
  writes?(input: string): string
}

/** A conversion an asset qualifies for, before it is measured or estimated. */
export interface Candidate {
  rule: SuggestionRule
  asset: Asset
  suggested: string
  how: string
  estimate: number
  converter?: Converter
}

const cwebpLossy: Converter = {
  tool: 'cwebp',
  output: 'webp',
  command: (input, output) => ['cwebp', '-quiet', '-q', '80', input, '-o', output],
}
const cwebpLossless: Converter = {
  tool: 'cwebp',
  output: 'webp',
  command: (input, output) => ['cwebp', '-quiet', '-lossless', input, '-o', output],
}
const avifenc: Converter = {
  tool: 'avifenc',
  output: 'avif',
  command: (input, output) => ['avifenc', '-s', '6', '-q', '60', input, output],
}
const ffmpegVorbis: Converter = {
  tool: 'ffmpeg',
  output: 'ogg',
  command: (input, output) => [
    'ffmpeg',
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    input,
    '-vn',
    '-c:a',
    'libvorbis',
    '-q:a',
    '4',
    output,
  ],
}
const woff2: Converter = {
  tool: 'woff2_compress',
  output: 'woff2',
  command: (input) => ['woff2_compress', input],
  writes: (input) => input.replace(/\.[^./]+$/, '.woff2'),
}

const ratio = (asset: Asset, value: number) => Math.round(asset.bytes * value)

function audioEstimate(asset: Asset): number {
  const duration = asset.audio?.durationMs
  if (duration) return Math.round(((duration / 1000) * VORBIS_Q4_BITRATE) / 8) + 4096
  return ratio(
    asset,
    asset.format === 'flac'
      ? estimateRatios['uncompressed-flac']
      : estimateRatios['uncompressed-pcm'],
  )
}

/**
 * The conversion an asset qualifies for, if any. One per asset: the most effective safe one.
 * AVIF is suggested (JPEG → AVIF) and mentioned only with `avif`.
 */
export function candidateFor(
  asset: Asset,
  options: { avif?: boolean } = {},
): Candidate | undefined {
  const image = asset.image
  const base = { asset }
  const avif = options.avif === true
  if ((asset.format === 'png' || asset.format === 'apng') && image && !image.animated) {
    return image.alpha
      ? {
          ...base,
          rule: 'alpha-png',
          suggested: 'webp',
          how: `WebP lossless (cwebp -lossless)${avif ? ', or AVIF with alpha' : ''}`,
          estimate: ratio(asset, estimateRatios['alpha-png']),
          converter: cwebpLossless,
        }
      : {
          ...base,
          rule: 'opaque-png',
          suggested: 'webp',
          how: `WebP lossy q80 (cwebp -q 80)${avif ? ', or AVIF' : ''}`,
          estimate: ratio(asset, estimateRatios['opaque-png']),
          converter: cwebpLossy,
        }
  }
  if (asset.format === 'jpg' || asset.format === 'jpeg') {
    return avif
      ? {
          ...base,
          rule: 'jpeg',
          suggested: 'avif',
          how: 'AVIF q60 (avifenc -q 60), WebP q80 as a fallback',
          estimate: ratio(asset, estimateRatios.jpeg),
          converter: avifenc,
        }
      : {
          ...base,
          rule: 'jpeg',
          suggested: 'webp',
          how: 'WebP lossy q80 (cwebp -q 80)',
          estimate: ratio(asset, estimateRatios['jpeg-webp']),
          converter: cwebpLossy,
        }
  }
  if (asset.format === 'gif' && image?.animated) {
    return {
      ...base,
      rule: 'animated-gif',
      suggested: 'webp',
      how: 'Animated WebP (gif2webp), or a looping video',
      estimate: ratio(asset, estimateRatios['animated-gif']),
    }
  }
  if ((asset.format === 'wav' || asset.format === 'flac') && asset.kind === 'audio') {
    return {
      ...base,
      rule: 'uncompressed-audio',
      suggested: 'ogg',
      how: 'Ogg Vorbis q4 (ffmpeg -c:a libvorbis -q:a 4); Opus or M4A/AAC for Safari',
      estimate: audioEstimate(asset),
      converter: ffmpegVorbis,
    }
  }
  if (asset.format === 'ttf' || asset.format === 'otf') {
    return {
      ...base,
      rule: 'desktop-font',
      suggested: 'woff2',
      how: 'WOFF2 (woff2_compress), subset to the glyphs you use',
      estimate: ratio(asset, estimateRatios['desktop-font']),
      converter: woff2,
    }
  }
  return undefined
}

/**
 * Assets worth converting. Build files identical to a source file are skipped (the source is
 * suggested instead), and so is everything below `minBytes`.
 */
export function candidates(
  assets: readonly Asset[],
  minBytes: number,
  options: { avif?: boolean } = {},
): Candidate[] {
  const sourceHashes = new Set(
    assets.filter((asset) => asset.origin === 'source').map((asset) => asset.hash),
  )
  return assets.flatMap((asset) => {
    if (asset.bytes < minBytes) return []
    if (asset.origin === 'build' && sourceHashes.has(asset.hash)) return []
    const candidate = candidateFor(asset, options)
    return candidate ? [candidate] : []
  })
}

const toSuggestion = (
  candidate: Candidate,
  expectedBytes: number,
  method: Suggestion['method'],
): Suggestion => ({
  id: `${candidate.rule}:${candidate.asset.path}`,
  rule: candidate.rule,
  path: candidate.asset.path,
  kind: candidate.asset.kind,
  format: candidate.asset.format,
  bytes: candidate.asset.bytes,
  suggested: candidate.suggested,
  how: candidate.how,
  expectedBytes,
  method,
  saving: candidate.asset.bytes - expectedBytes,
})

/** Suggestions from estimates, keeping those that save at least `minSaving` bytes. */
export function estimateSuggestions(list: readonly Candidate[], minSaving: number): Suggestion[] {
  return list
    .map((candidate) => toSuggestion(candidate, candidate.estimate, 'estimate'))
    .filter((suggestion) => suggestion.saving >= minSaving)
    .toSorted((a, b) => b.saving - a.saving || a.path.localeCompare(b.path))
}

export interface MeasureOptions {
  dir: string
  runner: CommandRunner
  minSaving: number
  /** Conversions running at once. Default 4. */
  concurrency?: number
  signal?: AbortSignal
}

/**
 * Suggestions measured by running converters on temporary copies; the repository is only read.
 * A candidate falls back to its estimate when it has no converter, the tool is not installed or
 * the conversion fails. Returns the tools that measured at least one asset.
 */
export async function measureSuggestions(
  list: readonly Candidate[],
  options: MeasureOptions,
): Promise<{ suggestions: Suggestion[]; tools: string[] }> {
  const temp = await mkdtemp(join(tmpdir(), 'holtkeeper-assets-'))
  const missing = new Set<string>()
  const used = new Set<string>()
  const results: Suggestion[] = []
  try {
    const measure = async (candidate: Candidate, index: number): Promise<Suggestion> => {
      const converter = candidate.converter
      if (!converter || missing.has(converter.tool) || options.signal?.aborted) {
        return toSuggestion(candidate, candidate.estimate, 'estimate')
      }
      const extension = candidate.asset.format
      const input = join(temp, `${index}-in.${extension}`)
      const output = join(temp, `${index}-out.${converter.output}`)
      try {
        await copyFile(join(options.dir, candidate.asset.path), input)
        const result = await options.runner.run(converter.command(input, output), {
          cwd: temp,
          timeoutMs: 120_000,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        const written = converter.writes?.(input) ?? output
        if (result.exitCode !== 0) {
          if (result.exitCode === 127) missing.add(converter.tool)
          return toSuggestion(candidate, candidate.estimate, 'estimate')
        }
        const bytes = (await stat(written)).size
        used.add(converter.tool)
        return toSuggestion(candidate, bytes, 'measured')
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('command not found'))
          missing.add(converter.tool)
        return toSuggestion(candidate, candidate.estimate, 'estimate')
      } finally {
        await rm(input, { force: true })
        await rm(output, { force: true })
        if (converter.writes) await rm(converter.writes(input), { force: true })
      }
    }
    let next = 0
    const worker = async () => {
      while (next < list.length) {
        const index = next++
        const candidate = list[index]
        if (candidate) results.push(await measure(candidate, index))
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  return {
    suggestions: results
      .filter((suggestion) => suggestion.saving >= options.minSaving)
      .toSorted((a, b) => b.saving - a.saving || a.path.localeCompare(b.path)),
    tools: [...used].toSorted(),
  }
}

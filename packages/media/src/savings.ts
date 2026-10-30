import { formatBytes } from '@holtkeeper/report'

import type { OutputFormat } from './types.ts'

/** The size facts of one variant. */
export interface SavingsVariant {
  format: OutputFormat
  width: number
  bytes: number
  density?: number
}

/** How the image is displayed, for transfer estimates. */
export interface SavingsUsage {
  /** CSS viewport widths; default 375, 768, 1440. */
  viewports?: number[]
  /** Device pixel ratio; default 2. */
  dpr?: number
  /** Fixed CSS width of the image; otherwise `fraction` of the viewport. */
  displayWidth?: number
  /** Share of the viewport width the image spans; default 1. */
  fraction?: number
}

export interface FormatSavings {
  format: OutputFormat
  /** Bytes of the largest variant of the format, the one comparable to the original. */
  bytes: number
  width: number
  /** Smallest variant of the format. */
  smallest: number
  saving: number
  /** Percent of the original saved, one decimal; negative when larger. */
  savingPercent: number
}

export interface ViewportPick {
  format: OutputFormat
  width: number
  bytes: number
}

export interface ViewportTransfer {
  viewport: number
  dpr: number
  /** Device pixels the image needs at this viewport. */
  needed: number
  /** Per format, the smallest variant that is wide enough (or the widest one). */
  picks: ViewportPick[]
  /** Smallest of `picks`. */
  best?: ViewportPick
  /** The original is sent whole at every viewport. */
  original: number
  savingPercent: number
}

export interface SavingsSummary {
  original: { bytes: number; width: number; format: string }
  formats: FormatSavings[]
  /** Format with the fewest bytes at full size. */
  best?: FormatSavings
  viewports: ViewportTransfer[]
}

const percent = (original: number, bytes: number) =>
  original > 0 ? Math.round(((original - bytes) / original) * 1000) / 10 : 0

const formatOrder: OutputFormat[] = ['avif', 'webp', 'png', 'jpeg', 'gif']

/**
 * Savings of variants against the original: per format at full size, and the bytes a browser
 * downloads at typical viewports when it picks the smallest sufficient variant (`srcset`
 * semantics: width descriptors by needed device pixels, density descriptors by DPR).
 */
export function savingsSummary(
  original: { bytes: number; width: number; format: string },
  variants: readonly SavingsVariant[],
  usage: SavingsUsage = {},
): SavingsSummary {
  const byFormat = formatOrder.flatMap((format) => {
    const list = variants
      .filter((variant) => variant.format === format)
      .toSorted((a, b) => a.width - b.width)
    return list.length ? [{ format, list }] : []
  })
  const formats: FormatSavings[] = byFormat.map(({ format, list }) => {
    const largest = list.at(-1) ?? list[0]
    const bytes = largest?.bytes ?? 0
    return {
      format,
      bytes,
      width: largest?.width ?? 0,
      smallest: Math.min(...list.map((variant) => variant.bytes)),
      saving: original.bytes - bytes,
      savingPercent: percent(original.bytes, bytes),
    }
  })
  const best = formats.toSorted((a, b) => a.bytes - b.bytes)[0]
  const dpr = usage.dpr ?? 2
  const viewports = (usage.viewports ?? [375, 768, 1440]).map((viewport): ViewportTransfer => {
    const css = usage.displayWidth ?? viewport * (usage.fraction ?? 1)
    const needed = Math.ceil(css * dpr)
    const picks = byFormat.flatMap(({ format, list }): ViewportPick[] => {
      const density = list.every((variant) => variant.density !== undefined)
      const ordered = density ? list.toSorted((a, b) => (a.density ?? 0) - (b.density ?? 0)) : list
      const chosen = density
        ? (ordered.find((variant) => (variant.density ?? 0) >= dpr) ?? ordered.at(-1))
        : (ordered.find((variant) => variant.width >= needed) ?? ordered.at(-1))
      return chosen ? [{ format, width: chosen.width, bytes: chosen.bytes }] : []
    })
    const bestPick = picks.toSorted((a, b) => a.bytes - b.bytes)[0]
    return {
      viewport,
      dpr,
      needed,
      picks,
      ...(bestPick ? { best: bestPick } : {}),
      original: original.bytes,
      savingPercent: percent(original.bytes, bestPick?.bytes ?? original.bytes),
    }
  })
  return { original, formats, ...(best ? { best } : {}), viewports }
}

const signed = (value: number) => `${value > 0 ? '−' : '+'}${Math.abs(value)}%`

/** Markdown tables of a summary, for merge request comments. */
export function savingsMarkdown(summary: SavingsSummary, title?: string): string {
  const lines: string[] = []
  if (title) lines.push(`**${title}**`, '')
  lines.push(
    '| Format | Width | Size | Change |',
    '| --- | ---: | ---: | ---: |',
    `| original ${summary.original.format} | ${summary.original.width} | ${formatBytes(summary.original.bytes)} | — |`,
    ...summary.formats.map(
      (format) =>
        `| ${format.format}${format === summary.best ? ' (best)' : ''} | ${format.width} | ${formatBytes(format.bytes)} | ${signed(format.savingPercent)} |`,
    ),
  )
  if (summary.viewports.length && summary.formats.length) {
    const formats = summary.formats.map((format) => format.format)
    lines.push(
      '',
      `| Viewport | Needs | ${formats.join(' | ')} | Original |`,
      `| --- | ---: | ${formats.map(() => '---:').join(' | ')} | ---: |`,
      ...summary.viewports.map((row) => {
        const cells = formats.map((format) => {
          const pick = row.picks.find((entry) => entry.format === format)
          return pick ? `${formatBytes(pick.bytes)} (${pick.width}w)` : '—'
        })
        return `| ${row.viewport} px @${row.dpr}x | ${row.needed} px | ${cells.join(' | ')} | ${formatBytes(row.original)} |`
      }),
    )
  }
  return lines.join('\n')
}

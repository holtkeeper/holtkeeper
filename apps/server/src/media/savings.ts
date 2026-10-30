import type { MediaSavings } from '@holtkeeper/api'

/** Percent saved by `bytes` against `original`, one decimal; negative when larger. */
export const savingsPercent = (original: number, bytes: number) =>
  original > 0 ? Math.round(((original - bytes) / original) * 1000) / 10 : 0

/** Per format, the variant at the largest width, compared with the original. */
export function summarizeSavings(
  originalBytes: number,
  variants: readonly { format: string; width: number; bytes: number }[],
): MediaSavings {
  const largest = new Map<string, { format: string; width: number; bytes: number }>()
  for (const variant of variants) {
    const current = largest.get(variant.format)
    if (
      !current ||
      variant.width > current.width ||
      (variant.width === current.width && variant.bytes < current.bytes)
    )
      largest.set(variant.format, variant)
  }
  const formats = [...largest.values()]
    .map(({ format, width, bytes }) => ({
      format,
      width,
      bytes,
      savingsPercent: savingsPercent(originalBytes, bytes),
    }))
    .toSorted((a, b) => a.bytes - b.bytes)
  const best = formats[0]
  return {
    originalBytes,
    formats,
    ...(best ? { bestFormat: best.format } : {}),
    bestSavingsPercent: best?.savingsPercent ?? 0,
  }
}

/** `img/hero.png` → `img/hero-640w.webp`. */
export function variantPath(file: string, format: string, width: number): string {
  const slash = file.lastIndexOf('/')
  const dir = slash >= 0 ? file.slice(0, slash + 1) : ''
  const name = file.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${dir}${stem}-${width}w.${format === 'jpeg' ? 'jpg' : format}`
}

/** Runs at most `concurrency` tasks at once; rejects new ones when `maxQueued` are waiting. */
export function createLimiter(concurrency: number, maxQueued: number) {
  let running = 0
  const waiting: (() => void)[] = []
  return async <T>(task: () => Promise<T>): Promise<T | 'busy'> => {
    if (running >= concurrency) {
      if (waiting.length >= maxQueued) return 'busy'
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else running += 1
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running -= 1
    }
  }
}

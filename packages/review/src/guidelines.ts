import { join } from 'node:path'

/** Repository files whose rules the review follows, in this order. */
export const GUIDELINE_FILES = ['REVIEW.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'] as const

export interface Guideline {
  file: string
  text: string
  truncated: boolean
}

/** Cuts `text` to at most `max` characters at a line break, marking the cut. */
export function trimText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const cut = text.lastIndexOf('\n', max)
  return { text: `${text.slice(0, cut > max / 2 ? cut : max)}\n[...]`, truncated: true }
}

/**
 * The guideline files present at the checkout root, each trimmed to `perFile` characters and all
 * together to `total`; files that do not fit are left out.
 */
export async function readGuidelines(
  dir: string,
  { perFile = 6000, total = 12_000 }: { perFile?: number; total?: number } = {},
): Promise<Guideline[]> {
  const found: Guideline[] = []
  let used = 0
  for (const file of GUIDELINE_FILES) {
    const handle = Bun.file(join(dir, file))
    // Files are read one by one so the budget goes to the earlier, more specific ones first.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await handle.exists())) continue
    // oxlint-disable-next-line no-await-in-loop
    const raw = (await handle.text()).trim()
    if (!raw) continue
    const trimmed = trimText(raw, Math.min(perFile, total - used))
    if (trimmed.text.length < 200 && trimmed.truncated) break
    found.push({ file, ...trimmed })
    used += trimmed.text.length
    if (used >= total) break
  }
  return found
}

/**
 * Path globs listed under a `## Ignore` (or `## Skip`) heading of REVIEW.md, one per bullet, with
 * or without backticks. Added to the review's `ignore` option.
 */
export function ignoredInReviewMd(text: string): string[] {
  const globs: string[] = []
  let inSection = false
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim())
    if (heading) {
      inSection = /^(ignore|skip)\b/i.test(heading[1] ?? '')
      continue
    }
    if (!inSection) continue
    const bullet = /^\s*[-*]\s+`?([^`\s]+)`?/.exec(line)
    if (bullet?.[1]) globs.push(bullet[1])
  }
  return globs
}

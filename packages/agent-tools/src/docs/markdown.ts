import { compareVersions } from '@holtkeeper/depgraph'

/** A Markdown section: a heading and the lines up to the next heading of the same or higher level. */
export interface Section {
  level: number
  title: string
  /** 1-based line of the heading. */
  line: number
  /** The heading line and its body. */
  lines: string[]
  /** The version the heading names, e.g. `2.1.0` for `## [2.1.0] - 2024-05-01`. */
  version?: string
}

const VERSION = /(?:^|[\s[(v@])v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)(?=$|[\s\])—–:,])/

/** The first version-like token in a heading, without a `v` prefix. */
export function headingVersion(title: string): string | undefined {
  return VERSION.exec(title)?.[1]
}

/** Every ATX heading as a section, code fences skipped. Sections nest: a section includes its subsections. */
export function sections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/)
  const headings: { level: number; title: string; index: number }[] = []
  let fence: string | undefined
  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    if (fenceMatch) {
      if (fence === undefined) fence = fenceMatch[1]
      else if (fenceMatch[1] === fence) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading?.[1] && heading[2] !== undefined)
      headings.push({ level: heading[1].length, title: heading[2], index })
  }
  return headings.map((heading, i) => {
    const next = headings.slice(i + 1).find((other) => other.level <= heading.level)
    const version = headingVersion(heading.title)
    return {
      level: heading.level,
      title: heading.title,
      line: heading.index + 1,
      lines: lines.slice(heading.index, next ? next.index : lines.length),
      ...(version ? { version } : {}),
    }
  })
}

/**
 * Release sections of a changelog: the headings with a version at the level most version
 * headings use, newest first as written.
 */
export function releases(markdown: string): Section[] {
  const versioned = sections(markdown).filter((section) => section.version)
  const counts = new Map<number, number>()
  for (const section of versioned) counts.set(section.level, (counts.get(section.level) ?? 0) + 1)
  const level = [...counts].toSorted((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
  return versioned.filter((section) => section.level === level)
}

/** Releases with `from < version <= to`; either bound may be missing. */
export function releasesBetween(list: readonly Section[], from?: string, to?: string): Section[] {
  return list.filter((section) => {
    const version = section.version
    if (!version) return false
    if (from !== undefined && compareVersions(version, from) <= 0) return false
    if (to !== undefined && compareVersions(version, to) > 0) return false
    return true
  })
}

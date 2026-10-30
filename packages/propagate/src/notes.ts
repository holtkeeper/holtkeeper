// oxlint-disable no-await-in-loop -- steps touch the same checkout or forge branch and run in order
import { join } from 'node:path'

import type { GitForge } from '@holtkeeper/forge'

import { compareVersionText } from './semver.ts'
import type { ReleaseNotes, ReleaseNotesSource } from './types.ts'

const versionInHeading = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/

/** Cuts `text` to at most `max` characters at a line boundary, marking the cut. */
export function trimText(text: string, max = 6000): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const end = cut.lastIndexOf('\n')
  return `${(end > max / 2 ? cut.slice(0, end) : cut).trimEnd()}\n\n…`
}

const inRange = (version: string, from: string | undefined, to: string) =>
  (compareVersionText(version, to) ?? 1) <= 0 &&
  (from === undefined || (compareVersionText(version, from) ?? -1) > 0)

/**
 * Sections of a changelog whose heading names a version in `(from, to]`, in file order. A section
 * runs to the next heading of the same or a higher level. `undefined` when no section matches.
 */
export function changelogExcerpt(
  text: string,
  from: string | undefined,
  to: string,
): string | undefined {
  const kept: string[] = []
  let level: number | undefined
  let keeping = false
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const depth = heading[1]!.length
      const version = versionInHeading.exec(heading[2]!)?.[1]
      if (version !== undefined && (level === undefined || depth <= level)) {
        level = depth
        keeping = inRange(version, from, to)
      } else if (version === undefined && level !== undefined && depth <= level) keeping = false
    }
    if (keeping) kept.push(line)
  }
  const excerpt = kept.join('\n').trim()
  return excerpt ? excerpt : undefined
}

const tagVersion = (name: string) => versionInHeading.exec(name)?.[1]

const changelogNames = ['CHANGELOG.md', 'changelog.md', 'Changelog.md', 'HISTORY.md']
const guideNames = ['MIGRATION.md', 'UPGRADING.md', 'migration.md', 'upgrading.md']

function combine(parts: { file: string; text: string }[], maxChars: number) {
  return trimText(parts.map(({ file, text }) => `### ${file}\n\n${text}`).join('\n\n'), maxChars)
}

/**
 * Release notes from the installed package: the matching `CHANGELOG.md` sections and any
 * `MIGRATION.md` / `UPGRADING.md` under `node_modules/<package>/`. npm only.
 */
export function nodeModulesNotes(options: { maxChars?: number } = {}): ReleaseNotesSource {
  const maxChars = options.maxChars ?? 8000
  return {
    async notes({ dir, package: name, ecosystem, from, to }) {
      if (ecosystem !== 'npm') return undefined
      const base = join(dir, 'node_modules', name)
      const parts: { file: string; text: string }[] = []
      for (const file of changelogNames) {
        const handle = Bun.file(join(base, file))
        if (!(await handle.exists())) continue
        const excerpt = changelogExcerpt(await handle.text(), from, to)
        if (excerpt) parts.push({ file, text: excerpt })
        break
      }
      for (const file of guideNames) {
        const handle = Bun.file(join(base, file))
        if (await handle.exists())
          parts.push({ file, text: trimText(await handle.text(), maxChars / 2) })
      }
      if (parts.length === 0) return undefined
      return {
        package: name,
        ...(from ? { from } : {}),
        to,
        source: `node_modules/${name}`,
        text: combine(parts, maxChars),
      }
    },
  }
}

/**
 * Release notes from the package's source repository on the forge, for packages mapped in
 * `sources` (`forge:path`, or a bare path on the same forge): changelog files at the target tag
 * (else the default branch), else the names of the tags in range. Sources on another forge than
 * `forgeId` are ignored.
 */
export function forgeNotes(options: {
  forge: Pick<GitForge, 'readFile' | 'listTags'>
  forgeId?: string
  sources: Record<string, string>
  maxChars?: number
}): ReleaseNotesSource {
  const maxChars = options.maxChars ?? 8000
  return {
    async notes({ package: name, from, to }) {
      const source = options.sources[name]
      if (!source) return undefined
      const colon = source.indexOf(':')
      const forgeId = colon === -1 ? undefined : source.slice(0, colon)
      const repo = colon === -1 ? source : source.slice(colon + 1)
      if (forgeId && options.forgeId && forgeId !== options.forgeId) return undefined
      const tags = options.forge.listTags
        ? await options.forge.listTags(repo, { limit: 200 }).catch(() => [])
        : []
      const inWave = tags.filter((tag) => {
        const version = tagVersion(tag.name)
        return version !== undefined && inRange(version, from, to)
      })
      const target = inWave.find((tag) => compareVersionText(tagVersion(tag.name) ?? '', to) === 0)
      const parts: { file: string; text: string }[] = []
      for (const ref of target ? [target.name, undefined] : [undefined]) {
        for (const file of changelogNames) {
          const text = await options.forge.readFile(repo, file, ref).catch(() => undefined)
          const excerpt = text ? changelogExcerpt(text, from, to) : undefined
          if (excerpt) {
            parts.push({ file, text: excerpt })
            break
          }
        }
        for (const file of guideNames) {
          const text = await options.forge.readFile(repo, file, ref).catch(() => undefined)
          if (text) parts.push({ file, text: trimText(text, maxChars / 2) })
        }
        if (parts.length) break
      }
      if (parts.length === 0 && inWave.length)
        parts.push({ file: 'tags', text: inWave.map((tag) => `- ${tag.name}`).join('\n') })
      if (parts.length === 0) return undefined
      return {
        package: name,
        ...(from ? { from } : {}),
        to,
        source: `${source}${target ? `@${target.name}` : ''}`,
        text: combine(parts, maxChars),
      }
    },
  }
}

/** Asks `sources` in order and answers with the first notes found; failing sources are skipped. */
export function chainNotes(sources: ReleaseNotesSource[]): ReleaseNotesSource {
  return {
    async notes(input) {
      for (const source of sources) {
        const found: ReleaseNotes | undefined = await source.notes(input).catch(() => undefined)
        if (found) return found
      }
      return undefined
    },
  }
}

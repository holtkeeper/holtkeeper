import { z } from 'zod'

import type { ReleaseSettings } from './settings.ts'
import type { ReleaseEntry } from './types.ts'
import {
  compareSchemeVersions,
  compareVersions,
  isValidVersion,
  isVersion,
  parsePackageTag,
  versionOfTag,
} from './version.ts'

/** Setting key of the Slack release announcements of a repository. */
export const releaseAnnounceSettingKey = 'releases.announce'

const channelId = z
  .string()
  .trim()
  .regex(/^[CG][A-Z0-9]{6,20}$/, 'a Slack channel id such as C0123ABCD (channel details › About)')

/**
 * Where and how new versions are announced in Slack. Every field has a default, so `{}` is valid
 * and announces nothing until `channels` names one.
 */
export const releaseAnnounceSchema = z.object({
  channels: z.array(channelId).max(20).default([]).describe('Slack channel ids, e.g. C0123ABCD'),
  tags: z
    .array(z.string().trim().min(1))
    .max(50)
    .optional()
    .describe(
      'Glob patterns of tag names, e.g. @acme/*@*; default: version tags of the release flow',
    ),
  groupWindowMinutes: z
    .number()
    .int()
    .min(0)
    .max(240)
    .default(10)
    .describe('Tags found within this many minutes of each other make one announcement'),
  notes: z.boolean().default(true).describe('AI description of the release'),
  tasks: z.boolean().default(true).describe('Tracker tasks of the release'),
  impact: z.boolean().default(true).describe('Connected repositories an upgrade breaks'),
  language: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe('Language of the prose; default: the review language, else English'),
})

/** A parsed `releases.announce` value. */
export type ReleaseAnnounceSettings = z.output<typeof releaseAnnounceSchema>

/** `releases.announce` with defaults; a value that does not parse announces nothing. */
export const releaseAnnounceSettings = (value: unknown): ReleaseAnnounceSettings =>
  releaseAnnounceSchema.safeParse(value ?? {}).data ?? releaseAnnounceSchema.parse({})

/** The `releases.announce` setting for the settings registry. */
export const releaseAnnounceDefinition = {
  key: releaseAnnounceSettingKey,
  label: 'Release announcements',
  description: 'Slack channels that get a message for every new version.',
  section: 'Releases',
  default: releaseAnnounceSchema.parse({}),
  schema: releaseAnnounceSchema,
  help: `Posts a message to Slack for every new version of the covered repositories, whatever releases them: Holtkeeper, changesets, release-please or a CI job. New tags are found by tag push webhooks and, as a fallback, by polling each repository's tags about every 15 minutes. Tags that existed before the setting got channels are never announced.

- **channels**: Slack channel ids, e.g. \`C0123ABCD\` (channel details › About). Invite the app first; it needs the \`chat:write\` scope. No channels, no announcements.
- **tags**: glob patterns of the tag names to announce, e.g. \`@acme/*@*\`. By default the version tags of the release flow (\`version.tagFormat\`) and package tags such as \`@acme/widgets@1.2.3\`.
- **groupWindowMinutes** (default 10): tags found within this window make one message, e.g. every package a monorepo released at once.
- **notes**: a short AI description with breaking changes and migration hints (one cheap call per message; left out when the AI budget is spent). **tasks**: tracker tasks with links. **impact**: which connected repositories an upgrade breaks, from the indexed public API and their usages.
- **language**: of the AI text; default the review language (\`analyzers.review\` › language), else English.

The most specific entry wins as a whole.`,
}

/** A tag an announcement names: the package it versions (monorepo tags) and the version. */
export interface AnnouncedTag {
  name: string
  sha: string
  /** Set for package tags such as `@acme/widgets@1.2.3`. */
  package?: string
  version: string
}

/** The tag as a version: package tags first by their own syntax, else `version.tagFormat`. */
function parseTag(
  settings: ReleaseSettings,
  name: string,
): Omit<AnnouncedTag, 'name' | 'sha'> | undefined {
  const formatted = versionOfTag(settings.version.tagFormat, name)
  if (formatted !== undefined && isValidVersion(settings, formatted)) return { version: formatted }
  const pkg = parsePackageTag(name)
  if (pkg) return { package: pkg.package, version: pkg.version.replace(/^v(?=\d)/u, '') }
  return undefined
}

/**
 * Whether `releases.announce` covers a tag, and what it versions. With `tags` a tag must match one
 * of the globs and counts even when it names no version; without them only version tags of the
 * release flow and package tags count.
 */
export function announcedTag(
  settings: ReleaseSettings,
  announce: Pick<ReleaseAnnounceSettings, 'tags'>,
  tag: { name: string; sha: string },
): AnnouncedTag | undefined {
  const parsed = parseTag(settings, tag.name)
  if (announce.tags?.length) {
    if (!announce.tags.some((glob) => new Bun.Glob(glob).match(tag.name))) return undefined
    return {
      name: tag.name,
      sha: tag.sha,
      ...(parsed ?? { version: isVersion(tag.name) ? tag.name.replace(/^v/u, '') : tag.name }),
    }
  }
  return parsed ? { name: tag.name, sha: tag.sha, ...parsed } : undefined
}

const isPrerelease = (version: string) => version.includes('-')

/**
 * The version before `tag` among `tags`: the highest lower version of the same package (or of the
 * repository for plain tags), release candidates only when `tag` is one or the flow makes them.
 */
export function previousTag(
  settings: ReleaseSettings,
  tag: AnnouncedTag,
  tags: readonly { name: string; sha: string }[],
): AnnouncedTag | undefined {
  const compare = (a: string, b: string) =>
    tag.package === undefined ? compareSchemeVersions(settings, a, b) : compareVersions(a, b)
  const prerelease = settings.version.prerelease || isPrerelease(tag.version)
  let best: AnnouncedTag | undefined
  for (const candidate of tags) {
    if (candidate.name === tag.name) continue
    const parsed = parseTag(settings, candidate.name)
    if (!parsed || parsed.package !== tag.package) continue
    if (!prerelease && isPrerelease(parsed.version)) continue
    if (compare(parsed.version, tag.version) >= 0) continue
    if (best && compare(parsed.version, best.version) <= 0) continue
    best = { name: candidate.name, sha: candidate.sha, ...parsed }
  }
  return best
}

/** Entries the commit conventions mark breaking (`feat!:`, a `BREAKING CHANGE:` footer). */
export const breakingEntries = (entries: readonly ReleaseEntry[]) =>
  entries.filter((entry) => entry.included && entry.breaking)

const scopesOf = (entry: ReleaseEntry) =>
  (entry.scope ?? '')
    .split(',')
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean)

/**
 * The entries of a monorepo range that belong to `packageName` (e.g. `@acme/widgets`), by
 * conventional-commit scope: when some entry is scoped to the package (`widgets` or the full name),
 * entries scoped only to something else are left out; unscoped entries always stay. When no entry
 * names the package, the scopes say nothing about packages and every entry is kept.
 */
export function packageEntries(
  entries: readonly ReleaseEntry[],
  packageName: string,
): ReleaseEntry[] {
  const names = new Set([packageName.toLowerCase(), packageName.split('/').at(-1)!.toLowerCase()])
  const mine = (entry: ReleaseEntry) => scopesOf(entry).some((scope) => names.has(scope))
  if (!entries.some(mine)) return [...entries]
  return entries.filter((entry) => scopesOf(entry).length === 0 || mine(entry))
}

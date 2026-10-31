import type { LibraryVersionRole } from '@holtkeeper/store'

import { type SemVer, compareParsed, compareSemver, parseSemver } from './semver.ts'
import type { LibraryIndexSettings, LibraryUse, MatrixVersion, PublishedLibrary } from './types.ts'

/** Roles from most to least important; `maxVersions` drops versions from the end of this list first. */
export const rolePriority: readonly LibraryVersionRole[] = [
  'used',
  'latest',
  'minor',
  'patch',
  'major',
  'first',
]

interface Parsed {
  version: string
  semver: SemVer
}

const newest = (list: Parsed[]) =>
  list.reduce<Parsed | undefined>(
    (best, item) => (!best || compareParsed(item.semver, best.semver) > 0 ? item : best),
    undefined,
  )

const oldest = (list: Parsed[]) =>
  list.reduce<Parsed | undefined>(
    (best, item) => (!best || compareParsed(item.semver, best.semver) < 0 ? item : best),
    undefined,
  )

const keyOf = (semver: SemVer) =>
  `${semver.major}.${semver.minor}.${semver.patch}-${semver.pre.join('.')}`

const rank = (roles: LibraryVersionRole[]) =>
  Math.min(...roles.map((role) => rolePriority.indexOf(role)))

/**
 * The versions of one library worth indexing, highest first: every `used` version; the newest
 * `patch` of each used `major.minor`; the newest `minor` of each used major; the newest stable
 * release (`latest`, the registry's `latest` tag when it is stable); the newest release of every
 * `major` above the highest used one up to `latest`; with `firstOfMajor`, the `first` release of
 * each of those majors. Prereleases count only when used. With more than `maxVersions` versions,
 * the least important roles go first (see `rolePriority`), newer before older within one role;
 * used versions are always kept. `uses` may contain other libraries' entries only if the caller
 * filtered them; every entry is taken as a use of this library.
 */
export function versionMatrix(
  uses: readonly LibraryUse[],
  published: PublishedLibrary | undefined,
  settings: Pick<LibraryIndexSettings, 'maxVersions' | 'firstOfMajor'>,
): MatrixVersion[] {
  const entries = new Map<string, { roles: Set<LibraryVersionRole>; usedBy: Set<string> }>()
  const entry = (version: string) => {
    let value = entries.get(version)
    if (!value) entries.set(version, (value = { roles: new Set(), usedBy: new Set() }))
    return value
  }

  const canonical = new Map<string, string>()
  const stable: Parsed[] = []
  for (const { version } of published?.versions ?? []) {
    const semver = parseSemver(version)
    if (!semver) continue
    canonical.set(keyOf(semver), version)
    if (!semver.pre.length) stable.push({ version, semver })
  }
  const named = (version: string) => {
    const semver = parseSemver(version)
    return (semver && canonical.get(keyOf(semver))) ?? version
  }

  const used: Parsed[] = []
  for (const use of uses) {
    const version = named(use.version)
    const value = entry(version)
    value.roles.add('used')
    value.usedBy.add(use.repo)
    const semver = parseSemver(version)
    if (semver && !used.some((item) => item.version === version)) used.push({ version, semver })
  }

  const tagged = published?.latest ? parseSemver(published.latest) : undefined
  const latest =
    tagged && !tagged.pre.length && published?.latest
      ? { version: named(published.latest), semver: tagged }
      : newest(stable)
  const cap = latest?.semver
  const upTo = cap ? stable.filter((item) => compareParsed(item.semver, cap) <= 0) : stable

  for (const minor of new Set(used.map((item) => `${item.semver.major}.${item.semver.minor}`))) {
    const pick = newest(
      upTo.filter((item) => `${item.semver.major}.${item.semver.minor}` === minor),
    )
    if (pick) entry(pick.version).roles.add('patch')
  }
  const usedMajors = new Set(used.map((item) => item.semver.major))
  for (const major of usedMajors) {
    const pick = newest(upTo.filter((item) => item.semver.major === major))
    if (pick) entry(pick.version).roles.add('minor')
  }
  if (latest) {
    entry(latest.version).roles.add('latest')
    const highest = usedMajors.size ? Math.max(...usedMajors) : undefined
    const above = upTo.filter(
      (item) =>
        highest !== undefined &&
        item.semver.major > highest &&
        item.semver.major <= latest.semver.major,
    )
    for (const major of new Set(above.map((item) => item.semver.major))) {
      const ofMajor = above.filter((item) => item.semver.major === major)
      const pick = newest(ofMajor)
      if (pick) entry(pick.version).roles.add('major')
      const first = settings.firstOfMajor ? oldest(ofMajor) : undefined
      if (first) entry(first.version).roles.add('first')
    }
  }

  const all = [...entries].map(([version, value]) => ({
    version,
    roles: rolePriority.filter((role) => value.roles.has(role)),
    usedBy: [...value.usedBy].toSorted(),
  }))
  const kept = all.filter((item) => item.roles.includes('used'))
  const rest = all
    .filter((item) => !item.roles.includes('used'))
    .toSorted((a, b) => rank(a.roles) - rank(b.roles) || compareSemver(b.version, a.version))
  const room = Math.max(0, settings.maxVersions - kept.length)
  return [...kept, ...rest.slice(0, room)].toSorted((a, b) => compareSemver(b.version, a.version))
}

import { gitHistory } from './git.ts'
import type { ChangelogLinks } from './links.ts'
import { parseCommit } from './parse.ts'
import { comparePackageTags, parsePackageTag } from './tags.ts'
import type {
  ChangedFile,
  ChangelogData,
  HistorySource,
  PackageRelease,
  ReleaseRef,
} from './types.ts'
import { compareVersions } from './version.ts'

export interface AnalyzeChangelogOptions {
  /** Local clone with tags fetched. */
  dir: string
  /** Release to describe: a tag, or any ref such as `HEAD` for unreleased changes. */
  to: string
  /** Defaults to the release before `to`; the whole history when there is none. */
  from?: string
  /** Defaults to `gitHistory()`. */
  history?: HistorySource
  links?: Pick<ChangelogLinks, 'templates'>
}

/** Upper bound of `ChangelogData.files`; the least changed files are dropped first. */
export const maxChangedFiles = 5000

const churn = (file: ChangedFile) => file.insertions + file.deletions

/**
 * The release before `to` on another commit: the next one in `refs` order, or the newest one
 * older than `to`.
 */
export function previousRelease(refs: ReleaseRef[], to: ReleaseRef): ReleaseRef | undefined {
  const index = refs.findIndex((ref) => ref.name === to.name)
  if (index !== -1) return refs.slice(index + 1).find((ref) => ref.sha !== to.sha)
  const at = Date.parse(to.date)
  return refs.find((ref) => ref.sha !== to.sha && Date.parse(ref.date) <= at)
}

/**
 * A commit carrying package tags is one monorepo release named by its sha, with all its tags;
 * any other ref is returned as it is.
 */
export function monorepoRelease(refs: ReleaseRef[], ref: ReleaseRef): ReleaseRef {
  const tags = refs.filter((candidate) => candidate.sha === ref.sha).map((tag) => tag.name)
  if (!tags.some((tag) => parsePackageTag(tag))) return ref
  return { name: ref.sha, sha: ref.sha, date: ref.date, tags: tags.toSorted() }
}

/** Packages a monorepo release published, each with its version before this release. */
export function releasedPackages(refs: ReleaseRef[], to: ReleaseRef): PackageRelease[] {
  const all = refs.flatMap((ref) => parsePackageTag(ref.name) ?? [])
  return (to.tags ?? [])
    .flatMap((tag) => parsePackageTag(tag) ?? [])
    .toSorted(comparePackageTags)
    .map((current) => {
      const previous = all
        .filter(
          (other) =>
            other.package === current.package &&
            compareVersions(other.version, current.version) < 0,
        )
        .toSorted(comparePackageTags)[0]
      return {
        name: current.package,
        version: current.version,
        tag: current.tag,
        ...(previous ? { previous: previous.version } : {}),
      }
    })
}

/** Collects what changed between two releases into serializable `ChangelogData`. */
export async function analyzeChangelog({
  dir,
  to,
  from,
  history = gitHistory(),
  links,
}: AnalyzeChangelogOptions): Promise<ChangelogData> {
  const refs = await history.listRefs(dir)
  const target = monorepoRelease(refs, await history.resolve(dir, to))
  const found = from ? await history.resolve(dir, from) : previousRelease(refs, target)
  const base = found && monorepoRelease(refs, found)
  const packages = target.tags ? releasedPackages(refs, target) : []
  const range = { to: target.sha, ...(base ? { from: base.sha } : {}) }
  const [commits, diff, changed] = await Promise.all([
    history.commits(dir, range),
    history.diffStat?.(dir, range),
    history.changedFiles?.(dir, range),
  ])
  const files = changed
    ?.toSorted((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path))
    .slice(0, maxChangedFiles)
  return {
    ...(base ? { from: base } : {}),
    to: target,
    commits: commits.map((commit) => {
      const parsed = parseCommit(commit.subject, commit.body)
      if (commit.parents.length > 1) parsed.merge = true
      return Object.assign(commit, { parsed })
    }),
    ...(diff ? { diff } : {}),
    ...(files ? { files } : {}),
    ...(changed && changed.length > maxChangedFiles ? { filesTruncated: true } : {}),
    ...(packages.length ? { packages } : {}),
    ...(links ? { links: links.templates } : {}),
  }
}

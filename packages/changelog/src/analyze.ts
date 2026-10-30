import { gitHistory } from './git.ts'
import type { ChangelogLinks } from './links.ts'
import { parseCommit } from './parse.ts'
import type { ChangedFile, ChangelogData, HistorySource, ReleaseRef } from './types.ts'

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

/** The release before `to`: the next one in `refs` order, or the newest one older than `to`. */
export function previousRelease(refs: ReleaseRef[], to: ReleaseRef): ReleaseRef | undefined {
  const index = refs.findIndex((ref) => ref.name === to.name)
  if (index !== -1) return refs[index + 1]
  const at = Date.parse(to.date)
  return refs.find((ref) => ref.sha !== to.sha && Date.parse(ref.date) <= at)
}

/** Collects what changed between two releases into serializable `ChangelogData`. */
export async function analyzeChangelog({
  dir,
  to,
  from,
  history = gitHistory(),
  links,
}: AnalyzeChangelogOptions): Promise<ChangelogData> {
  const target = await history.resolve(dir, to)
  const base = from
    ? await history.resolve(dir, from)
    : previousRelease(await history.listRefs(dir), target)
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
    ...(links ? { links: links.templates } : {}),
  }
}

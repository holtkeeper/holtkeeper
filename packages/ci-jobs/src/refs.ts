/**
 * Kind of ref a pipeline ran for: the default branch, a long-lived development branch, a release
 * or hotfix branch, any other branch, a merge request (GitLab's `refs/merge-requests/…`), a tag.
 */
export type RefGroup = 'default' | 'develop' | 'release' | 'feature' | 'merge-request' | 'tag'

/** Display order and labels of the groups. */
export const refGroups: readonly { group: RefGroup; label: string }[] = [
  { group: 'default', label: 'Default branch' },
  { group: 'develop', label: 'Development branches' },
  { group: 'release', label: 'Release and hotfix branches' },
  { group: 'feature', label: 'Feature branches' },
  { group: 'merge-request', label: 'Merge requests' },
  { group: 'tag', label: 'Tags' },
]

const DEVELOP = /^(dev|develop|development|staging|stage|next|integration)$/i
const RELEASE = /^(release|releases|hotfix|hotfixes|rc|support)([/_-]|$)/i
const MAINLINE = /^(main|master|trunk)$/i

/**
 * The group of a ref. `defaultBranch` wins when known; otherwise `main`, `master` and `trunk` are
 * the default branch. Tags are recognized only through `tag`, since tag names look like branches.
 */
export function refGroupOf(
  ref: string | undefined,
  options: { tag?: boolean; defaultBranch?: string } = {},
): RefGroup {
  if (options.tag) return 'tag'
  const name = ref ?? ''
  if (name.startsWith('refs/merge-requests/') || name.startsWith('refs/pull/'))
    return 'merge-request'
  if (options.defaultBranch ? name === options.defaultBranch : MAINLINE.test(name)) return 'default'
  if (DEVELOP.test(name)) return 'develop'
  if (RELEASE.test(name)) return 'release'
  return 'feature'
}

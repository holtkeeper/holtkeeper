/**
 * Kind of ref a pipeline ran for: a mainline branch (`main`, `master`, `trunk`, `production`), a
 * long-lived development branch, a release or hotfix branch, any other branch, a merge request
 * (GitLab's `refs/merge-requests/…`), a tag.
 */
export type RefGroup = 'main' | 'develop' | 'release' | 'feature' | 'merge-request' | 'tag'

/** Display order and labels of the groups. */
export const refGroups: readonly { group: RefGroup; label: string }[] = [
  { group: 'main', label: 'Main branches' },
  { group: 'develop', label: 'Development branches' },
  { group: 'release', label: 'Release and hotfix branches' },
  { group: 'feature', label: 'Feature branches' },
  { group: 'merge-request', label: 'Merge requests' },
  { group: 'tag', label: 'Tags' },
]

const MAINLINE = /^(main|master|trunk|production|prod)$/i
const DEVELOP = /^(dev|develop|development|staging|stage|next|integration)$/i
const RELEASE = /^(release|releases|hotfix|hotfixes|rc|support)([/_-]|$)/i

/**
 * The group of a ref by its name. The forge's default branch joins the main branches unless its
 * name already puts it among development branches (a `development` default stays there). Tags
 * are recognized only through `tag`, since tag names look like branches.
 */
export function refGroupOf(
  ref: string | undefined,
  options: { tag?: boolean; defaultBranch?: string } = {},
): RefGroup {
  if (options.tag) return 'tag'
  const name = ref ?? ''
  if (name.startsWith('refs/merge-requests/') || name.startsWith('refs/pull/'))
    return 'merge-request'
  if (MAINLINE.test(name)) return 'main'
  if (DEVELOP.test(name)) return 'develop'
  if (name && name === options.defaultBranch) return 'main'
  if (RELEASE.test(name)) return 'release'
  return 'feature'
}

const semverTag =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** A git tag that releases one Go module of the repository. */
export interface GoModuleTag {
  tag: string
  /** Module path with its `/vN` suffix. */
  module: string
  /** Directory of the module's `go.mod`, relative to the repository; `.` for the root. */
  dir: string
  version: string
}

const majorSuffix = (path: string) => /\/v([2-9]|[1-9]\d+)$/.exec(path)?.[1]

/** Tag prefix of a module: its directory, without a trailing major-version directory (`v2`). */
const tagPrefixOf = (module: { module: string; dir: string }) => {
  const dir = module.dir === '.' ? '' : module.dir.replace(/^\.\//, '').replace(/\/$/, '')
  const major = majorSuffix(module.module)
  if (major && (dir === `v${major}` || dir.endsWith(`/v${major}`)))
    return dir.slice(0, -`v${major}`.length).replace(/\/$/, '')
  return dir
}

/**
 * Which module each tag releases, by Go's tagging rules: `vX.Y.Z` releases the module at the
 * repository root (or the one in a `vN` major-version directory), `dir/vX.Y.Z` the module at `dir`
 * (or `dir/vN`). The tag's major must agree with the module path: `/vN` paths take only `vN`
 * versions, paths without a suffix only `v0` and `v1`. Tags that are not semantic versions, or
 * match no module, are left out; a tag may release at most one module.
 */
export function goModuleTags(
  tags: readonly string[],
  modules: readonly { module: string; dir: string }[],
): GoModuleTag[] {
  const prefixes = modules.map((module) => ({ module, prefix: tagPrefixOf(module) }))
  const found: GoModuleTag[] = []
  for (const tag of tags) {
    const slash = tag.lastIndexOf('/')
    const prefix = slash < 0 ? '' : tag.slice(0, slash)
    const version = tag.slice(slash + 1)
    const parsed = semverTag.exec(version)
    if (!parsed) continue
    const major = Number(parsed[1])
    const owner = prefixes.find((candidate) => {
      if (candidate.prefix !== prefix) return false
      const suffix = majorSuffix(candidate.module.module)
      return suffix ? Number(suffix) === major : major <= 1
    })
    if (owner) found.push({ tag, module: owner.module.module, dir: owner.module.dir, version })
  }
  return found
}

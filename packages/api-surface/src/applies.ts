import { type Applicability, anyOf, hasFile } from '@holtkeeper/analyzer'
import type { GitForge } from '@holtkeeper/forge'

const skippedSegment = (segment: string) =>
  segment === 'vendor' ||
  segment === 'testdata' ||
  segment === 'node_modules' ||
  segment.startsWith('.') ||
  segment.startsWith('_')

const canList = (forge: object): forge is Required<Pick<GitForge, 'listFiles'>> =>
  'listFiles' in forge && typeof forge.listFiles === 'function'

/**
 * Applies when the repository has a `go.mod` at most `depth` directories deep (default 4, as
 * module discovery looks), outside `vendor/`, `testdata/`, `node_modules/` and hidden folders.
 * Checks the root `go.mod` and `go.work` first; nested modules are only found when the forge
 * client can list the tree, otherwise a repository without a root `go.mod` does not apply.
 */
export const hasGoModule =
  (depth = 4): Applicability =>
  async (context) => {
    if (await hasFile('go.mod', 'go.work')(context)) return true
    const { forge, repo } = context
    if (!canList(forge)) return false
    const entries = await forge.listFiles(repo.path, { recursive: true })
    return entries.some((entry) => {
      if (entry.type !== 'file') return false
      const segments = entry.path.split('/')
      return (
        segments.at(-1) === 'go.mod' &&
        segments.length - 1 <= depth &&
        !segments.slice(0, -1).some(skippedSegment)
      )
    })
  }

/** Applies to repositories with npm packages (a root `package.json`) or Go modules. */
export const apiSurfaceApplies: Applicability = anyOf(hasFile('package.json'), hasGoModule())

import { type Applicability, anyOf, hasFile } from '@holtkeeper/analyzer'

interface TreeLister {
  listFiles(
    repo: string,
    options?: { recursive?: boolean },
  ): Promise<{ path: string; type: 'file' | 'dir' }[]>
}

const canList = (forge: object): forge is TreeLister =>
  'listFiles' in forge && typeof forge.listFiles === 'function'

const skippedSegment = (segment: string) =>
  segment === 'vendor' ||
  segment === 'testdata' ||
  segment === 'node_modules' ||
  segment.startsWith('.') ||
  segment.startsWith('_')

/**
 * Applies when the repository has a root `go.mod` or `go.work`, or a `go.mod` at most `depth`
 * directories deep outside `vendor/`, `testdata/`, `node_modules/`, hidden and `_`-prefixed
 * folders. Nested modules are only found when the forge client can list the tree.
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

/** Applies to repositories with a root `package.json` or a Go module (see `hasGoModule`). */
export const usagesApplies: Applicability = anyOf(hasFile('package.json'), hasGoModule())

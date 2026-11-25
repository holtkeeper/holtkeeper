import { type GoMod, parseGoMod, parseGoSum } from '@holtkeeper/go-source'

import { type Files, byText, errorText, finishRoot, inRoot, transitiveChanges } from './shared.ts'
import type { DependencyRoot, DirectDependencyChange } from './types.ts'

const compareVersions = (a: string, b: string) => {
  try {
    return Bun.semver.order(a.replace(/^v/, ''), b.replace(/^v/, ''))
  } catch {
    return byText(a, b)
  }
}

function sumVersions(text: string | undefined): Map<string, string[]> | undefined {
  if (text === undefined) return undefined
  const versions = new Map<string, Set<string>>()
  for (const entry of parseGoSum(text)) {
    if (entry.kind !== 'module') continue
    versions.set(entry.path, (versions.get(entry.path) ?? new Set()).add(entry.version))
  }
  return new Map([...versions].map(([path, set]) => [path, [...set].toSorted(compareVersions)]))
}

/** Direct (`go.mod`) and transitive (`go.sum`) changes of one Go module; never throws. */
export async function goRoot(files: Files, dir: string): Promise<DependencyRoot> {
  const modPath = inRoot(dir, 'go.mod')
  const sumPath = inRoot(dir, 'go.sum')
  const [fromMod, toMod, fromSum, toSum] = await Promise.all([
    files.read(modPath, 'from'),
    files.read(modPath, 'to'),
    files.read(sumPath, 'from'),
    files.read(sumPath, 'to'),
  ])
  const errors: string[] = []
  const parse = (text: string | undefined, side: string): GoMod | undefined => {
    if (text === undefined) return undefined
    try {
      return parseGoMod(text)
    } catch (error) {
      errors.push(`${modPath} could not be parsed at ${side}: ${errorText(error)}`)
      return undefined
    }
  }
  const before = parse(fromMod, 'from')
  const after = parse(toMod, 'to')
  if (fromMod === undefined && toMod === undefined) errors.push(`${modPath} exists at neither side`)

  const workspace = after?.module || before?.module || dir || '.'
  const was = new Map((before?.require ?? []).map((req) => [req.path, req]))
  const now = new Map((after?.require ?? []).map((req) => [req.path, req]))
  const direct: DirectDependencyChange[] = []
  for (const path of new Set([...was.keys(), ...now.keys()])) {
    const old = was.get(path)
    const req = now.get(path)
    const field = (req ?? old)?.indirect ? 'indirect' : 'require'
    if (!old && req)
      direct.push({ name: path, change: 'added', field, workspace, to: { version: req.version } })
    else if (old && !req)
      direct.push({
        name: path,
        change: 'removed',
        field,
        workspace,
        from: { version: old.version },
      })
    else if (old && req && old.version !== req.version)
      direct.push({
        name: path,
        change: 'updated',
        field,
        workspace,
        from: { version: old.version },
        to: { version: req.version },
      })
  }

  const hasSum = fromSum !== undefined || toSum !== undefined
  const transitive =
    hasSum && fromSum !== toSum
      ? transitiveChanges(
          sumVersions(fromSum),
          sumVersions(toSum),
          new Set([...was.keys(), ...now.keys()]),
        )
      : []

  return finishRoot({
    path: dir,
    ecosystem: 'go',
    manager: 'go',
    ...(hasSum ? { lockfile: 'go.sum' } : {}),
    direct,
    transitive,
    errors: [...files.failuresOf([modPath, sumPath]), ...errors],
  })
}

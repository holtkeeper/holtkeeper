import type { RepoRef, Scope, SettingView } from '@holtkeeper/api'

import { repoKey } from './repo.ts'

/** A glob offered for leaving a file out, with what it covers. */
export interface ExcludeChoice {
  pattern: string
  label: string
}

/** `path` as a glob that matches only itself: glob syntax characters are escaped. */
export const globEscape = (path: string) => path.replace(/[\\*?[\]{}!]/g, '\\$&')

/**
 * Globs for leaving `path` out, narrowest first: the file itself, files with its extension in its
 * folder, its folder and every parent folder, and the file name anywhere.
 */
export function excludeChoices(path: string): ExcludeChoice[] {
  const parts = path.split('/').filter(Boolean)
  const name = parts.at(-1) ?? path
  const folders = parts.slice(0, -1)
  const extension = /\.([^./]+)$/.exec(name)?.[1]
  const folder = (depth: number) => folders.slice(0, depth).map(globEscape).join('/')
  const choices: ExcludeChoice[] = [{ pattern: globEscape(path), label: 'This file' }]
  if (extension)
    choices.push({
      pattern: `${folders.length ? `${folder(folders.length)}/` : ''}*.${globEscape(extension)}`,
      label: `.${extension} files in this folder`,
    })
  for (let depth = folders.length; depth > 0; depth--)
    choices.push({
      pattern: `${folder(depth)}/**`,
      label: depth === folders.length ? 'This folder' : `Everything under ${folders[depth - 1]}/`,
    })
  if (folders.length) choices.push({ pattern: `**/${globEscape(name)}`, label: `${name} anywhere` })
  return choices
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The setting entry to write so `option` of `repo` also lists `pattern`. The entry naming the
 * repository is extended in place; otherwise a new entry for the repository starts from the
 * winning broader value, since the most specific entry replaces it as a whole.
 */
export function excludeEntry(
  key: string,
  option: string,
  pattern: string,
  repo: RepoRef,
  effective: SettingView | undefined,
): { id?: string; key: string; scope: Scope; value: Record<string, unknown> } {
  const value = isRecord(effective?.value) ? effective.value : {}
  const current = Array.isArray(value[option])
    ? value[option].filter((item): item is string => typeof item === 'string')
    : []
  const next = { ...value, [option]: current.includes(pattern) ? current : [...current, pattern] }
  const own = (effective?.scope.repos ?? []).some(
    (entry) => entry === repoKey(repo) || entry === repo.path,
  )
  return own && effective && !effective.scope.groups?.length && !effective.scope.all
    ? { id: effective.id, key, scope: effective.scope, value: next }
    : { key, scope: { repos: [repoKey(repo)] }, value: next }
}

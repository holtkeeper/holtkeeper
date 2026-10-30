import type { CatalogFile, CatalogFiles } from './detect.ts'
import { localeTag, locateCatalog } from './locate.ts'
import type { CatalogSource, ChangeTarget } from './types.ts'

/** Values of the repository placeholders in `files` templates. */
export interface TemplateVars {
  /** Full path of the analyzed repository, e.g. `games/app-x`. */
  repo: string
  /** Last path segment, e.g. `app-x`. */
  repoName: string
  /** Path without the last segment, e.g. `games`. */
  group: string
}

/** `games/app-x` → `{ repo: 'games/app-x', repoName: 'app-x', group: 'games' }`. */
export function templateVars(repoPath: string): TemplateVars {
  const parts = repoPath.split('/').filter(Boolean)
  return {
    repo: parts.join('/'),
    repoName: parts.at(-1) ?? '',
    group: parts.slice(0, -1).join('/'),
  }
}

/** A compiled `files` template: matches paths and renders them back. */
export interface FileTemplate {
  /** Captured `locale` (normalized) and `namespace` of a matching path, else `undefined`. */
  match(file: string): { locale?: string; namespace?: string } | undefined
  /** The path for a locale and namespace; `undefined` when the template has globs. */
  render(values: { locale: string; namespace?: string }): string | undefined
  /** Whether the template captures a namespace. */
  hasNamespace: boolean
}

const escape = (text: string) => text.replace(/[.+^$()|[\]\\]/g, '\\$&')

/**
 * Compiles a `files` template: `{locale}`, `{namespace}`, `{repo}`, `{repoName}`, `{group}`,
 * `*` (within a segment) and `**` (any depth). Repository placeholders are filled from `vars`.
 */
export function compileTemplate(template: string, vars: TemplateVars): FileTemplate {
  const filled = template
    .replace(/\{repo\}/g, vars.repo)
    .replace(/\{repoName\}/g, vars.repoName)
    .replace(/\{group\}/g, vars.group)
    .replace(/^\.?\/+/, '')
  let pattern = ''
  const seen = new Set<string>()
  for (const token of filled.split(/(\{locale\}|\{namespace\}|\*\*\/|\*\*|\*)/)) {
    if (token === '{locale}' || token === '{namespace}') {
      const name = token.slice(1, -1)
      if (seen.has(name)) pattern += `\\k<${name}>`
      else {
        seen.add(name)
        pattern +=
          name === 'locale'
            ? '(?<locale>[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)'
            : '(?<namespace>[^/]+?)'
      }
    } else if (token === '**/') pattern += '(?:.*/)?'
    else if (token === '**') pattern += '.*'
    else if (token === '*') pattern += '[^/]*'
    else pattern += escape(token)
  }
  const regex = new RegExp(`^${pattern}$`)
  const globbed = /\*/.test(filled)
  return {
    hasNamespace: seen.has('namespace'),
    match(file) {
      const found = regex.exec(file)
      if (!found) return undefined
      const groups = found.groups
      const raw = groups?.locale
      const locale = raw === undefined ? undefined : localeTag(raw)
      if (raw !== undefined && !locale) return undefined
      return {
        ...(locale ? { locale } : {}),
        ...(groups?.namespace ? { namespace: groups.namespace } : {}),
      }
    },
    render({ locale, namespace }) {
      if (globbed || (seen.has('namespace') && !namespace)) return undefined
      return filled.replace(/\{locale\}/g, locale).replace(/\{namespace\}/g, namespace ?? '')
    },
  }
}

/** A configured catalog layer. */
export interface LayerSpec {
  id: string
  /** `forge:path` of the repository holding the layer; absent for the analyzed repository. */
  repo?: string
  ref?: string
  /** Path template, see `compileTemplate`. */
  files: string
  format?: 'json' | 'yaml' | 'po' | 'properties' | 'auto'
  /** Namespace of the layer's files when the template has no `{namespace}`. */
  namespace?: string
}

/** `gitlab:games/app` → `{ forge: 'gitlab', path: 'games/app' }`. */
export function parseRepo(text: string): ChangeTarget {
  const colon = text.indexOf(':')
  if (colon <= 0 || colon === text.length - 1)
    throw new Error(`expected "forge:path", got "${text}"`)
  return { forge: text.slice(0, colon), path: text.slice(colon + 1) }
}

const repoKey = (repo: ChangeTarget) => `${repo.forge}:${repo.path}`

/** Whether a layer lives outside `analyzed` and must be checked out separately. */
export const isExternal = (layer: Pick<LayerSpec, 'repo'>, analyzed: ChangeTarget) =>
  layer.repo !== undefined && layer.repo !== repoKey(analyzed)

/**
 * Repositories the runner must check out besides the analyzed one, once each; pass their
 * directories back as `__checkouts` (`{ 'forge:path': dir }`).
 */
export function requiredCheckouts(
  options: { layers?: readonly Pick<LayerSpec, 'repo' | 'ref'>[] },
  analyzed: ChangeTarget,
): { repo: ChangeTarget; ref?: string }[] {
  const seen = new Map<string, { repo: ChangeTarget; ref?: string }>()
  for (const layer of options.layers ?? []) {
    if (!layer.repo || !isExternal(layer, analyzed)) continue
    const key = `${layer.repo}@${layer.ref ?? ''}`
    if (!seen.has(key))
      seen.set(key, { repo: parseRepo(layer.repo), ...(layer.ref ? { ref: layer.ref } : {}) })
  }
  return [...seen.values()]
}

/**
 * Catalog files of one layer. Each file's bundle is its namespace (`default` without one), so
 * layers merge per namespace.
 */
export async function layerCatalogs(
  layer: LayerSpec,
  files: CatalogFiles,
  vars: TemplateVars,
  sources: readonly CatalogSource[],
): Promise<{ files: CatalogFile[]; errors: { file: string; message: string }[] }> {
  const template = compileTemplate(layer.files, vars)
  const format = layer.format && layer.format !== 'auto' ? layer.format : undefined
  const result: { files: CatalogFile[]; errors: { file: string; message: string }[] } = {
    files: [],
    errors: [],
  }
  for (const file of await files.list()) {
    const matched = template.match(file)
    if (!matched) continue
    const source = sources.find((s) => (format ? s.format === format : s.matches(file)))
    if (!source) continue
    const locale =
      matched.locale ?? (source.locate ? source.locate(file) : locateCatalog(file))?.locale
    if (!locale) continue
    const namespace = matched.namespace ?? layer.namespace
    const text = await files.read(file)
    if (text === undefined) continue
    try {
      result.files.push({
        file,
        text,
        source,
        layer: layer.id,
        location: { locale, bundle: namespace ?? 'default', ...(namespace ? { namespace } : {}) },
        catalog: source.parse(text, file),
      })
    } catch (error) {
      result.errors.push({ file, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

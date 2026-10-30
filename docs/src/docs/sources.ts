import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { groupOf, moduleGroups } from './groups.ts'

export const repoUrl = 'https://github.com/holtkeeper/holtkeeper'
const branch = 'main'

/** A markdown file from the repository that the site renders in place. */
export interface DocSource {
  /** Absolute path on disk. */
  file: string
  /** Path from the repository root, with forward slashes. */
  path: string
  /** Route id in the `docs` collection, e.g. `modules/forge-gitlab`. */
  id: string
  /** Sidebar label. */
  label: string
  /** Title that replaces the first heading, when the heading reads badly as a page title. */
  title?: string
  /** Module group for the sidebar; absent for guide pages and the modules index. */
  group?: string
  /** Position among siblings. */
  order: number
}

const guideOrder = ['PLAN.md', 'development.md', 'deployment.md']
const guideLabels: Record<string, string> = {
  'PLAN.md': 'Plan',
  'development.md': 'Development',
  'deployment.md': 'Deployment',
}

const nonEmpty = (file: string) => existsSync(file) && statSync(file).size > 0

const posix = (path: string) => path.split(sep).join('/')

const moduleTableOrder = (root: string) => {
  const index = join(root, 'docs/README.md')
  if (!existsSync(index)) return []
  return [
    ...readFileSync(index, 'utf8').matchAll(
      /\]\(\.\.\/(?:apps|packages|plugins)\/([^/]+)\/docs\/README\.md\)/g,
    ),
  ].map((m) => m[1] ?? '')
}

/** Every markdown file the site renders, discovered from the repository layout. */
export function discoverDocs(root: string): DocSource[] {
  const sources: DocSource[] = []
  const docsDir = join(root, 'docs')

  const names = readdirSync(docsDir).filter((n) => n.endsWith('.md'))
  for (const name of names.toSorted()) {
    const file = join(docsDir, name)
    if (!nonEmpty(file)) continue
    if (name === 'README.md') {
      sources.push({
        file,
        path: `docs/${name}`,
        id: 'modules',
        label: 'Overview',
        title: 'Modules',
        order: -1,
      })
      continue
    }
    const known = guideOrder.indexOf(name)
    const slug = name.replace(/\.md$/, '').toLowerCase()
    sources.push({
      file,
      path: `docs/${name}`,
      id: `guide/${slug}`,
      label: guideLabels[name] ?? slug.replace(/^\w/, (c) => c.toUpperCase()),
      order: known >= 0 ? known : guideOrder.length,
    })
  }

  const tableOrder = moduleTableOrder(root)
  for (const area of ['apps', 'packages', 'plugins']) {
    const areaDir = join(root, area)
    if (!existsSync(areaDir)) continue
    for (const dir of readdirSync(areaDir).toSorted()) {
      const file = join(areaDir, dir, 'docs/README.md')
      if (!nonEmpty(file)) continue
      const position = tableOrder.indexOf(dir)
      sources.push({
        file,
        path: `${area}/${dir}/docs/README.md`,
        id: `modules/${dir}`,
        label: dir,
        group: groupOf(dir),
        order: position >= 0 ? position : tableOrder.length,
      })
    }
  }
  return sources
}

/** Sidebar items for the two documentation topics. */
export function sidebarTopics(sources: DocSource[]) {
  const byOrder = (a: DocSource, b: DocSource) =>
    a.order - b.order || a.label.localeCompare(b.label)
  const guide = sources.filter((s) => s.id.startsWith('guide/')).toSorted(byOrder)
  const modules = sources.filter((s) => s.group).toSorted(byOrder)
  const groups = moduleGroups
    .map((group) => ({
      label: group.label,
      collapsed: !('open' in group && group.open),
      items: modules.filter((s) => s.group === group.label).map((s) => s.id),
    }))
    .filter((g) => g.items.length > 0)
  return {
    guide: ['guide/getting-started', ...guide.map((s) => s.id)],
    modules: ['modules', ...groups],
  }
}

/** Resolves a link written in a repository markdown file to a site route or a GitHub URL. */
export function createLinkResolver(root: string, sources: DocSource[]) {
  const routes = new Map(sources.map((s) => [s.file, `/${s.id}/`]))
  return (url: string, fromFile: string, kind: 'link' | 'image' = 'link'): string => {
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return url
    const hashAt = url.indexOf('#')
    const target = hashAt >= 0 ? url.slice(0, hashAt) : url
    const hash = hashAt >= 0 ? url.slice(hashAt) : ''
    const absolute = resolve(dirname(fromFile), decodeURIComponent(target))
    const route = routes.get(absolute)
    if (route) return route + hash
    const path = posix(relative(root, absolute))
    if (path.startsWith('..')) return url
    if (kind === 'image')
      return `https://raw.githubusercontent.com/holtkeeper/holtkeeper/${branch}/${path}`
    const isDir = existsSync(absolute) && statSync(absolute).isDirectory()
    return `${repoUrl}/${isDir ? 'tree' : 'blob'}/${branch}/${path}${hash}`
  }
}

/** URL that opens the source file in GitHub's editor. */
export const editUrl = (path: string) => `${repoUrl}/edit/${branch}/${path}`

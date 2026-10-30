import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { docsLoader } from '@astrojs/starlight/loaders'
import type { Loader, LoaderContext } from 'astro/loaders'

import { type DocSource, discoverDocs, editUrl } from './sources.ts'

const plain = (markdown: string) =>
  markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Splits a frontmatter-less markdown file into its first `# H1`, the body without it, and a description. */
function splitMarkdown(raw: string): { title?: string; body: string; description?: string } {
  const match = /^\s*# (.+)\n/.exec(raw)
  const title = match?.[1] ? plain(match[1]) : undefined
  const body = match ? raw.slice(match[0].length) : raw
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(?:#|```|\||- |\* |\d+\. |>|<)/.test(block))
  const description = paragraph ? plain(paragraph) : undefined
  return { title, body, description }
}

async function loadSource(context: LoaderContext, source: DocSource) {
  const raw = readFileSync(source.file, 'utf8')
  const split = splitMarkdown(raw)
  const data = await context.parseData({
    id: source.id,
    filePath: source.file,
    data: {
      title: source.title ?? split.title ?? source.label,
      ...(split.description ? { description: split.description } : {}),
      editUrl: editUrl(source.path),
      sidebar: { label: source.label },
    },
  })
  const rendered = await context.renderMarkdown(split.body, { fileURL: pathToFileURL(source.file) })
  context.store.set({
    id: source.id,
    data,
    body: split.body,
    rendered,
    filePath: relative(fileURLToPath(context.config.root), source.file),
    digest: context.generateDigest(raw),
  })
}

/**
 * The Starlight `docs` collection: pages under `src/content/docs/` plus the repository's own
 * markdown (project docs and every module's `docs/README.md`), rendered from where they live.
 */
export function repositoryDocsLoader(): Loader {
  const local = docsLoader()
  return {
    name: 'holtkeeper-repository-docs',
    async load(context) {
      await local.load(context)
      const root = fileURLToPath(new URL('../', context.config.root))
      const sources = discoverDocs(root)
      for (const source of sources) await loadSource(context, source)
      context.watcher?.add(sources.map((s) => s.file))
      context.watcher?.on('change', (changed) => {
        const source = sources.find((s) => s.file === changed)
        if (source) void loadSource(context, source)
      })
    },
  }
}

import { fileURLToPath } from 'node:url'

import type { AstroIntegration } from 'astro'

type Resolve = (url: string, fromFile: string, kind?: 'link' | 'image') => string

interface UrlNode {
  url: string
}

interface VisitorContext {
  fileURL?: URL
  setProperty(node: UrlNode, key: 'url', value: string): void
}

const visit =
  (resolve: Resolve, kind: 'link' | 'image') => (node: UrlNode, context: VisitorContext) => {
    if (!context.fileURL) return
    const next = resolve(node.url, fileURLToPath(context.fileURL), kind)
    if (next !== node.url) context.setProperty(node, 'url', next)
  }

/**
 * Rewrites relative links in repository markdown: links between rendered files become site
 * routes, links to anything else become GitHub URLs. Registers an mdast plugin on the
 * Sätteri processor (Astro's default); must come after integrations that replace the processor.
 */
export function repositoryLinks(resolve: Resolve): AstroIntegration {
  return {
    name: 'holtkeeper-repository-links',
    hooks: {
      'astro:config:setup': ({ config, logger }) => {
        const processor = config.markdown.processor
        const options = processor.options as { mdastPlugins?: unknown[] }
        if (processor.name !== 'satteri' || !Array.isArray(options.mdastPlugins)) {
          logger.warn(`links are not rewritten: unsupported markdown processor "${processor.name}"`)
          return
        }
        options.mdastPlugins.push({
          name: 'holtkeeper-repository-links',
          link: visit(resolve, 'link'),
          definition: visit(resolve, 'link'),
          image: visit(resolve, 'image'),
        })
      },
    },
  }
}

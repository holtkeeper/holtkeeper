import { docsSchema } from '@astrojs/starlight/schema'
import { defineCollection } from 'astro:content'

import { repositoryDocsLoader } from './docs/loader.ts'

export const collections = {
  docs: defineCollection({ loader: repositoryDocsLoader(), schema: docsSchema() }),
}

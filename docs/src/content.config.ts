import { docsSchema } from '@astrojs/starlight/schema'
import { z } from 'astro/zod'
import { defineCollection } from 'astro:content'

import { repositoryDocsLoader } from './docs/loader.ts'

export const collections = {
  docs: defineCollection({
    loader: repositoryDocsLoader(),
    schema: docsSchema({
      extend: z.object({
        /** Where the page lives in the panel, as its breadcrumb: `Quality › Bundles`. */
        panel: z.string().optional(),
        /** The panel route of the page: `/quality/bundles`. */
        route: z.string().optional(),
        /** The permission a person needs to open the page: `analyses:read`. */
        permission: z.string().optional(),
      }),
    }),
  }),
}

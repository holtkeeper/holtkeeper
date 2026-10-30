import { z } from 'zod'

import type { StackData } from './types.ts'

const cycle = z.object({
  cycle: z.string().min(1),
  releaseDate: z.string().optional(),
  eol: z.union([z.string(), z.boolean()]),
  lts: z.union([z.string(), z.boolean()]).optional(),
  latest: z.string().optional(),
})

/** Validates `StackData`, e.g. uploads or records read back from the store. */
export const stackDataSchema: z.ZodType<StackData> = z.object({
  group: z.string(),
  checkedAt: z.string(),
  soonDays: z.number().int().nonnegative(),
  repos: z.array(
    z.object({
      path: z.string().min(1),
      webUrl: z.string().optional(),
      files: z.array(z.string()),
      error: z.string().optional(),
      archived: z.boolean().optional(),
    }),
  ),
  components: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(['runtime', 'package-manager', 'service', 'os', 'image', 'tool']),
      latest: z.string().optional(),
      latestLts: z.string().optional(),
      source: z.string().optional(),
      cycles: z.array(cycle).optional(),
      usages: z.array(
        z.object({
          repo: z.string().min(1),
          file: z.string().min(1),
          via: z.enum(['version-file', 'dockerfile', 'compose', 'ci', 'deploy']),
          declared: z.string(),
          version: z.string().optional(),
          variant: z.string().optional(),
          image: z.string().optional(),
        }),
      ),
    }),
  ),
  notes: z.array(z.object({ repo: z.string().optional(), message: z.string() })),
})

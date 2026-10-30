import { z } from 'zod'

import type { ChangelogData } from './types.ts'

const person = z.object({ name: z.string(), email: z.string() })

const releaseRef = z.object({
  name: z.string().min(1),
  sha: z.string().min(1),
  date: z.string(),
  message: z.string().optional(),
})

const diffStat = z.object({
  files: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
})

const parsedCommit = z.object({
  type: z.string().optional(),
  scope: z.string().optional(),
  breaking: z.boolean(),
  breakingNote: z.string().optional(),
  description: z.string(),
  tickets: z.array(z.string()),
  mergeRequests: z.array(z.number().int()),
  merge: z.boolean(),
  revert: z.object({ subject: z.string().optional(), sha: z.string().optional() }).optional(),
  coAuthors: z.array(person),
  wip: z.boolean(),
})

const linkTemplates = z.object({
  commit: z.string(),
  compare: z.string(),
  mergeRequest: z.string(),
  tag: z.string(),
  issue: z.string(),
  ticket: z.string().optional(),
})

const changedFile = z.object({
  path: z.string().min(1),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']).optional(),
  previousPath: z.string().optional(),
  binary: z.boolean().optional(),
})

/** Validates `ChangelogData` received from analyzers, e.g. uploads from CI. */
export const changelogDataSchema: z.ZodType<ChangelogData> = z.object({
  from: releaseRef.optional(),
  to: releaseRef,
  commits: z.array(
    z.object({
      sha: z.string().min(1),
      parents: z.array(z.string()),
      author: person,
      date: z.string(),
      subject: z.string(),
      body: z.string(),
      stats: diffStat,
      parsed: parsedCommit,
    }),
  ),
  diff: diffStat.optional(),
  files: z.array(changedFile).optional(),
  filesTruncated: z.boolean().optional(),
  links: linkTemplates.optional(),
})

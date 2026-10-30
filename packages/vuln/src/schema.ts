import { z } from 'zod'

import { allowlistEntrySchema } from './allowlist.ts'

const severity = z.enum(['critical', 'high', 'medium', 'low', 'unknown'])

/** A `Finding` as JSON, e.g. in uploaded reports. */
export const findingSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string()),
  summary: z.string(),
  severity,
  url: z.string(),
  package: z.object({ name: z.string(), version: z.string(), ecosystem: z.string() }),
  source: z.string(),
  fixedVersions: z.array(z.string()),
})

/** An `AuditReport` as JSON, e.g. a report a CLI or CI run uploads. */
export const auditReportSchema = z.object({
  scanner: z.string(),
  findings: z.array(findingSchema),
  ignored: z.array(z.object({ finding: findingSchema, entry: allowlistEntrySchema })),
  expired: z.array(allowlistEntrySchema),
  fixes: z.array(
    z.object({
      fixer: z.string(),
      source: z.string(),
      requested: z.array(z.string()),
      changedFiles: z.array(z.string()),
      fixed: z.array(z.string()),
      notes: z.array(z.string()),
      error: z.string().optional(),
    }),
  ),
  resolved: z.array(findingSchema),
  changedFiles: z.array(z.string()),
})

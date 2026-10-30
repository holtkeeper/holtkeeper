import { scopeSchema } from '@holtkeeper/access'
import { allowlistEntrySchema } from '@holtkeeper/vuln'
import { z } from 'zod'

const severity = z.enum(['critical', 'high', 'medium', 'low', 'unknown'])

const findingSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string()),
  summary: z.string(),
  severity,
  url: z.string(),
  package: z.object({ name: z.string(), version: z.string(), ecosystem: z.string() }),
  source: z.string(),
  fixedVersions: z.array(z.string()),
})

const auditReportSchema = z.object({
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

/** `POST /api/audit-runs` */
export const ingestAuditRunSchema = z.object({
  repo: z.object({ forge: z.string().min(1), path: z.string().min(1) }),
  trigger: z.enum(['cli', 'schedule', 'manual', 'webhook']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  report: auditReportSchema,
})

/** `PUT /api/settings` */
export const putSettingSchema = z.object({
  id: z.string().min(1).optional(),
  key: z.string().min(1),
  scope: scopeSchema,
  value: z.unknown(),
})

export const credentialTestSchema = z
  .object({ model: z.string().trim().min(1).optional() })
  .default({})

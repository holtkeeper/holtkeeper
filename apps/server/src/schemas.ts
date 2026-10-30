import { scopeSchema } from '@holtkeeper/access'
import { auditReportSchema } from '@holtkeeper/vuln'
import { z } from 'zod'

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

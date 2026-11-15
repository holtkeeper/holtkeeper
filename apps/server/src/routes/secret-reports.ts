import { can } from '@holtkeeper/access'
import type {
  SecretReportList,
  SecretReportView,
  SecretReportsLicense,
  UpdateSecretReportInput,
} from '@holtkeeper/api'
import { LICENSE_NAME, licenseText, reportStatuses } from '@holtkeeper/secret-reports'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, authorize, principalOf, readBody } from '../context.ts'
import type { SecretReports } from '../secret-reports.ts'

const GLOBAL = { kind: 'global' } as const

const updateSchema = z
  .object({
    status: z.enum(reportStatuses).optional(),
    note: z.string().max(2000).optional(),
  })
  .refine((input) => input.status !== undefined || input.note !== undefined, {
    message: 'send status, note or both',
  })

/**
 * `/api/secret-reports`: the reports agents sent with `report_secret_exposure`, for people with
 * `credentials:read` on everything (changes need `credentials:write`), and the license text with
 * its use condition for anyone signed in. Every route but the license answers 404 when secret
 * reports are off.
 */
export function secretReportRoutes(reports: SecretReports | undefined) {
  const routes = new Hono<Env>()
  const enabled = () => {
    if (!reports) throw new HTTPException(404, { message: 'secret reports are off' })
    return reports
  }

  routes.get('/secret-reports/license', async (c) => {
    principalOf(c)
    return c.json<SecretReportsLicense>({ name: LICENSE_NAME, text: await licenseText() })
  })

  routes.get('/secret-reports', async (c) => {
    const principal = authorize(c, 'credentials:read', GLOBAL)
    const list: SecretReportView[] = await enabled().store.list()
    return c.json<SecretReportList>({
      reports: list,
      canWrite: can(principal, 'credentials:write', GLOBAL),
    })
  })

  routes.patch('/secret-reports/:id', async (c) => {
    const principal = authorize(c, 'credentials:write', GLOBAL)
    const input: UpdateSecretReportInput = await readBody(c, updateSchema)
    const updated = await enabled().store.update(
      c.req.param('id'),
      {
        ...(input.status && { status: input.status }),
        ...(input.note !== undefined && { note: input.note }),
      },
      principal.id,
    )
    if (!updated) throw new HTTPException(404, { message: 'no such report' })
    c.set('audit', {
      action: 'secret_report.update',
      target: { type: 'secret_report', id: updated.id },
      details: {
        identifier: updated.identifier,
        ...(input.status && { status: input.status }),
        ...(input.note !== undefined && { note: true }),
      },
    })
    return c.json<SecretReportView>(updated)
  })

  return routes
}

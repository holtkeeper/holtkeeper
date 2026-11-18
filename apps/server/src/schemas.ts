import { scopeSchema } from '@holtkeeper/access'
import { z } from 'zod'

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

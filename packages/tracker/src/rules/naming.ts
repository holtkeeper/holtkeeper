import { z } from 'zod'

import type { RuleHit } from './types.ts'
import { type Rule, ruleFields, withRoles } from './types.ts'

const schema = z.object({
  kind: z.literal('naming'),
  ...ruleFields,
  /** Regular expression every spelling must match, e.g. `^[a-z][a-z0-9_]*$`. */
  pattern: z.string().min(1),
  /** Check the key as written (`raw`) or the normalized key. Default `raw`. */
  on: z.enum(['raw', 'key']).default('raw'),
  /** Roles whose spellings are checked. Default `definition`. */
  roles: z.array(z.string().min(1)).default(['definition']),
})

/** Keys whose spelling does not follow a naming convention. */
export const namingRule = {
  kind: 'naming',
  schema,
  severity: 'warning',
  evaluate(entities, config, { label }) {
    const pattern = new RegExp(config.pattern)
    const hits: RuleHit[] = []
    for (const entity of entities) {
      const occurrences = withRoles(entity, config.roles).filter(
        (occurrence) =>
          !pattern.test(config.on === 'key' ? entity.key : (occurrence.raw ?? entity.key)),
      )
      if (!occurrences.length) continue
      const names = [
        ...new Set(
          occurrences.map((occurrence) =>
            config.on === 'key' ? entity.key : (occurrence.raw ?? entity.key),
          ),
        ),
      ]
      hits.push({
        key: entity.key,
        message: `${label} ${names.join(', ')} does not match ${config.pattern}`,
        occurrences,
      })
    }
    return hits
  },
} satisfies Rule<z.output<typeof schema>>

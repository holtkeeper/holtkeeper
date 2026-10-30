import { z } from 'zod'

import type { Occurrence } from '../types.ts'
import { listPlaces, type Rule, ruleFields, type RuleHit, withRoles } from './types.ts'

const schema = z.object({
  kind: z.literal('attribute-mismatch'),
  ...ruleFields,
  /** Attribute of the reference side, e.g. `default`. */
  attr: z.string().min(1),
  /** Role of the reference side. Default `definition`. */
  role: z.string().min(1).default('definition').meta({ 'x-role': 'reads' }),
  /** The compared side; `attr` defaults to the reference attribute. */
  against: z
    .object({
      role: z.string().min(1).default('config').meta({ 'x-role': 'reads' }),
      attr: z.string().min(1).optional(),
    })
    .default({ role: 'config' }),
  /** Only these environments; default every environment and occurrences without one. */
  environments: z.array(z.string().min(1)).optional(),
})

const truthy = new Set(['true', 'yes', 'on', '1', 'enabled'])
const falsy = new Set(['false', 'no', 'off', '0', 'disabled'])

const asBoolean = (value: string) =>
  truthy.has(value) ? 'true' : falsy.has(value) ? 'false' : undefined

/** Loose equality of attribute values: case, surrounding space, number spelling and boolean words are ignored. */
export function sameValue(a: string, b: string): boolean {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (left === right) return true
  const leftBoolean = asBoolean(left)
  if (leftBoolean !== undefined && leftBoolean === asBoolean(right)) return true
  return (
    left !== '' && right !== '' && !Number.isNaN(Number(left)) && Number(left) === Number(right)
  )
}

/** Values of one attribute that differ between two roles, e.g. a flag's default in code vs its Helm value per environment. */
export const attributeMismatchRule = {
  kind: 'attribute-mismatch',
  schema,
  severity: 'warning',
  evaluate(entities, config) {
    const otherAttr = config.against.attr ?? config.attr
    const hits: RuleHit[] = []
    for (const entity of entities) {
      const reference = withRoles(entity, [config.role]).find(
        (occurrence) => occurrence.attrs[config.attr] !== undefined,
      )
      if (!reference) continue
      const expected = reference.attrs[config.attr]!
      const byEnvironment = new Map<string, Occurrence[]>()
      for (const occurrence of withRoles(entity, [config.against.role])) {
        const actual = occurrence.attrs[otherAttr]
        if (actual === undefined || sameValue(expected, actual)) continue
        const environment = occurrence.environment ?? ''
        if (config.environments && !config.environments.includes(environment)) continue
        byEnvironment.set(environment, [...(byEnvironment.get(environment) ?? []), occurrence])
      }
      for (const [environment, occurrences] of byEnvironment) {
        const values = [
          ...new Set(occurrences.map((occurrence) => occurrence.attrs[otherAttr])),
        ].join(', ')
        hits.push({
          key: entity.key,
          ...(environment ? { environment } : {}),
          message: `${entity.key}: ${config.attr} is ${expected} in ${config.role}, but ${otherAttr} is ${values} in ${listPlaces(occurrences)}${environment ? ` (${environment})` : ''}`,
          occurrences: [reference, ...occurrences],
        })
      }
    }
    return hits
  },
} satisfies Rule<z.output<typeof schema>>

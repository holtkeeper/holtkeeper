import { z } from 'zod'

import type { Entity } from '../types.ts'
import {
  definitionRoles,
  listPlaces,
  type Rule,
  ruleFields,
  type RuleHit,
  withRoles,
} from './types.ts'

/** Entities that have `present` occurrences but no `absent` ones. */
function presentWithout(
  entities: readonly Entity[],
  present: readonly string[],
  absent: readonly string[],
  message: (entity: Entity, where: string) => string,
): RuleHit[] {
  return entities.flatMap((entity) => {
    const found = withRoles(entity, present)
    if (!found.length || withRoles(entity, absent).length) return []
    return [{ key: entity.key, message: message(entity, listPlaces(found)), occurrences: found }]
  })
}

const unusedSchema = z.object({
  kind: z.literal('unused'),
  ...ruleFields,
  definition: definitionRoles,
  usage: z.array(z.string().min(1)).default(['usage']),
})

/** Definitions nothing uses. */
export const unusedRule = {
  kind: 'unused',
  schema: unusedSchema,
  severity: 'warning',
  evaluate: (entities, config, { label }) =>
    presentWithout(
      entities,
      config.definition,
      config.usage,
      (entity, where) => `${label} ${entity.key} is defined in ${where} but never used`,
    ),
} satisfies Rule<z.output<typeof unusedSchema>>

const undefinedSchema = z.object({
  kind: z.literal('undefined'),
  ...ruleFields,
  definition: definitionRoles,
  /** Roles that need a definition; narrow it when `stale-config` or `documented-missing` also run. */
  roles: z.array(z.string().min(1)).default(['usage', 'config', 'documentation']),
})

/** Usages, config entries or docs of keys nothing defines. */
export const undefinedRule = {
  kind: 'undefined',
  schema: undefinedSchema,
  severity: 'error',
  evaluate: (entities, config, { label }) =>
    presentWithout(
      entities,
      config.roles,
      config.definition,
      (entity, where) => `${label} ${entity.key} is referenced in ${where} but not defined`,
    ),
} satisfies Rule<z.output<typeof undefinedSchema>>

const staleConfigSchema = z.object({
  kind: z.literal('stale-config'),
  ...ruleFields,
  definition: definitionRoles,
  config: z.array(z.string().min(1)).default(['config']),
})

/** Config entries (e.g. Helm values) for keys that are no longer defined. */
export const staleConfigRule = {
  kind: 'stale-config',
  schema: staleConfigSchema,
  severity: 'warning',
  evaluate: (entities, config, { label }) =>
    presentWithout(
      entities,
      config.config,
      config.definition,
      (entity, where) =>
        `${where} still configures ${label.toLowerCase()} ${entity.key}, which is not defined`,
    ),
} satisfies Rule<z.output<typeof staleConfigSchema>>

const documentationRoles = z.array(z.string().min(1)).default(['documentation'])

const undocumentedSchema = z.object({
  kind: z.literal('undocumented'),
  ...ruleFields,
  definition: definitionRoles,
  documentation: documentationRoles,
})

/** Definitions the documentation does not mention. */
export const undocumentedRule = {
  kind: 'undocumented',
  schema: undocumentedSchema,
  severity: 'info',
  evaluate: (entities, config, { label }) =>
    presentWithout(
      entities,
      config.definition,
      config.documentation,
      (entity, where) => `${label} ${entity.key} (${where}) is not documented`,
    ),
} satisfies Rule<z.output<typeof undocumentedSchema>>

const documentedMissingSchema = z.object({
  kind: z.literal('documented-missing'),
  ...ruleFields,
  definition: definitionRoles,
  documentation: documentationRoles,
})

/** Documentation entries for keys that are not defined. */
export const documentedMissingRule = {
  kind: 'documented-missing',
  schema: documentedMissingSchema,
  severity: 'warning',
  evaluate: (entities, config, { label }) =>
    presentWithout(
      entities,
      config.documentation,
      config.definition,
      (entity, where) =>
        `${where} documents ${label.toLowerCase()} ${entity.key}, which is not defined`,
    ),
} satisfies Rule<z.output<typeof documentedMissingSchema>>

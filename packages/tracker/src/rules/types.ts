import { z } from 'zod'

import type { Entity, Occurrence, Severity } from '../types.ts'

/** What a rule reports about one key; the engine adds ids and severity. */
export interface RuleHit {
  key: string
  message: string
  environment?: string
  occurrences: Occurrence[]
}

/** What every rule may use besides the entities. */
export interface RuleContext {
  /** Entity label from the definition, e.g. `Feature flag`. */
  label: string
}

/** One rule kind. `evaluate` is pure: same entities and config, same hits. */
export interface Rule<Config extends { kind: string } = { kind: string }> {
  kind: Config['kind']
  schema: z.ZodType<Config>
  /** Severity when the config does not set one. */
  severity: Severity
  evaluate(entities: readonly Entity[], config: Config, context: RuleContext): RuleHit[]
}

/** Config fields every rule accepts. */
export const ruleFields = {
  /** Distinguishes two rules of the same kind; default the kind. */
  id: z.string().min(1).optional(),
  severity: z.enum(['info', 'warning', 'error']).optional(),
  /** Key globs the rule skips. */
  ignore: z.array(z.string().min(1)).optional(),
}

/** Roles that count as defining an entity. */
export const definitionRoles = z.array(z.string().min(1)).default(['definition'])

/** Occurrences of `entity` with one of `roles`. */
export const withRoles = (entity: Entity, roles: readonly string[]) =>
  entity.occurrences.filter((occurrence) => roles.includes(occurrence.role))

/** Where an occurrence is, for messages: `repo/file:line`, a document title, ... */
export function placeOf(occurrence: Occurrence): string {
  if (occurrence.document)
    return occurrence.document.title ?? `${occurrence.document.provider}:${occurrence.document.ref}`
  const file = occurrence.file
    ? `${occurrence.repo ? `${occurrence.repo}/` : ''}${occurrence.file}`
    : (occurrence.repo ?? occurrence.source)
  return occurrence.line ? `${file}:${occurrence.line}` : file
}

/** `a`, `a and b`, `a, b and 2 more`. */
export function listPlaces(occurrences: readonly Occurrence[], limit = 2): string {
  const places = [...new Set(occurrences.map(placeOf))]
  if (places.length <= limit) return places.join(' and ')
  return `${places.slice(0, limit).join(', ')} and ${places.length - limit} more`
}

import { z } from 'zod'

import { matchesAny } from '../glob.ts'
import type { Entity, Finding } from '../types.ts'
import { attributeMismatchRule } from './attribute-mismatch.ts'
import { namingRule } from './naming.ts'
import {
  documentedMissingRule,
  staleConfigRule,
  undefinedRule,
  undocumentedRule,
  unusedRule,
} from './presence.ts'
import type { Rule, RuleContext } from './types.ts'

/** Validates a rule config of any registered kind. */
export const ruleSchema = z.discriminatedUnion('kind', [
  unusedRule.schema,
  undefinedRule.schema,
  staleConfigRule.schema,
  undocumentedRule.schema,
  documentedMissingRule.schema,
  attributeMismatchRule.schema,
  namingRule.schema,
])

/** A rule config. */
export type RuleConfig = z.output<typeof ruleSchema>

/** Rules by kind. */
export const rules: Record<RuleConfig['kind'], Rule> = {
  unused: unusedRule,
  undefined: undefinedRule,
  'stale-config': staleConfigRule,
  undocumented: undocumentedRule,
  'documented-missing': documentedMissingRule,
  'attribute-mismatch': attributeMismatchRule,
  naming: namingRule,
}

/** Findings of one rule config: hits with stable ids, severity and `ignore` applied. */
export function evaluateRule(
  entities: readonly Entity[],
  config: RuleConfig,
  context: RuleContext,
): Finding[] {
  const rule = rules[config.kind]
  const ruleId = config.id ?? config.kind
  return rule
    .evaluate(entities, config, context)
    .filter((hit) => !config.ignore || !matchesAny(hit.key, config.ignore))
    .map((hit) => ({
      id: `${ruleId}:${hit.key}${hit.environment ? `:${hit.environment}` : ''}`,
      rule: config.kind,
      ruleId,
      severity: config.severity ?? rule.severity,
      key: hit.key,
      message: hit.message,
      ...(hit.environment ? { environment: hit.environment } : {}),
      occurrences: hit.occurrences,
    }))
}

export { sameValue } from './attribute-mismatch.ts'
export { listPlaces, placeOf, type Rule, type RuleContext, type RuleHit } from './types.ts'

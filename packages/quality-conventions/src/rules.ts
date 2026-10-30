import { type Rule, kind as kindId } from '@ast-grep/napi'

import type { ParserName } from './languages/types.ts'

const validity = new Map<string, boolean>()

/** Whether `kind` is a node kind of the language's grammar. */
export function isKind(parser: ParserName, kind: string): boolean {
  const key = `${parser}\0${kind}`
  let valid = validity.get(key)
  if (valid === undefined) {
    try {
      valid = kindId(parser, kind) !== 0
    } catch {
      valid = false
    }
    validity.set(key, valid)
  }
  return valid
}

const RELATIONS = ['inside', 'has', 'follows', 'precedes'] as const

/**
 * `rule` with the parts that name kinds the grammar lacks removed, so one rule serves related
 * grammars (TypeScript and JavaScript). Returns `undefined` when the rule can never match.
 */
export function adaptRule(parser: ParserName, rule: Rule): Rule | undefined {
  if (rule.kind !== undefined && !isKind(parser, String(rule.kind))) return undefined
  const adapted: Rule = { ...rule }
  if (rule.any) {
    const any = rule.any.flatMap((part) => adaptRule(parser, part) ?? [])
    if (!any.length) return undefined
    adapted.any = any
  }
  if (rule.all) {
    const all = rule.all.map((part) => adaptRule(parser, part))
    if (all.some((part) => part === undefined)) return undefined
    adapted.all = all.filter((part) => part !== undefined)
  }
  if (rule.not) {
    const not = adaptRule(parser, rule.not)
    if (not) adapted.not = not
    else delete adapted.not
  }
  for (const relation of RELATIONS) {
    const related = rule[relation]
    if (!related) continue
    const inner = adaptRule(parser, related)
    if (!inner) return undefined
    adapted[relation] = { ...related, ...inner }
  }
  return adapted
}

import { prefixScore, searchWords } from './search.ts'
import type { Rule, RuleContent, RuleRevision, RuleStore } from './types.ts'

/** Thrown by `RuleStore.put` when `expectedVersion` is not the stored version. */
export class RuleVersionConflictError extends Error {
  readonly id: string
  readonly stored: number

  constructor(id: string, stored: number) {
    super(`rule ${id} is at version ${stored}`)
    this.name = 'RuleVersionConflictError'
    this.id = id
    this.stored = stored
  }
}

const clone = <T>(value: T): T => structuredClone(value)

const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** By title ignoring case, then by id: the order of `RuleStore.list`. */
const byRuleTitle = (a: Rule, b: Rule) =>
  binary(a.title.toLowerCase(), b.title.toLowerCase()) || binary(a.id, b.id)

/** The versioned part of a rule, as rule histories keep it; absent optional fields stay absent. */
export const ruleContent = (rule: RuleContent): RuleContent => ({
  title: rule.title,
  body: rule.body,
  scope: rule.scope,
  ...(rule.files !== undefined && { files: rule.files }),
  ...(rule.agents !== undefined && { agents: rule.agents }),
  ...(rule.description !== undefined && { description: rule.description }),
  ...(rule.alwaysApply !== undefined && { alwaysApply: rule.alwaysApply }),
})

/** The in-memory `RuleStore`; search scores rules by weighted prefix matches of words. */
export function memoryRules(): RuleStore {
  const rules = new Map<string, Rule>()
  const histories = new Map<string, RuleRevision[]>()

  return {
    async put(input, expectedVersion) {
      const previous = rules.get(input.id)
      const stored = previous?.version ?? 0
      if (expectedVersion !== undefined && expectedVersion !== stored)
        throw new RuleVersionConflictError(input.id, stored)
      if (previous) {
        const revision: RuleRevision = {
          ...clone(ruleContent(previous)),
          version: previous.version,
          editedBy: previous.updatedBy ?? previous.author,
          editedAt: previous.updatedAt,
        }
        histories.set(input.id, [revision, ...(histories.get(input.id) ?? [])])
      }
      const rule: Rule = { ...clone(input), version: stored + 1 }
      rules.set(rule.id, rule)
      return clone(rule)
    },
    get: async (id) => clone(rules.get(id)),
    list: async () => [...rules.values()].toSorted(byRuleTitle).map(clone),
    history: async (id) => clone(histories.get(id) ?? []),
    async remove(id) {
      rules.delete(id)
      histories.delete(id)
    },
    async search(text, limit = 20) {
      const terms = [...new Set(searchWords(text))]
      if (!terms.length) return []
      return [...rules.values()]
        .map((rule) => ({
          rule,
          score: prefixScore(terms, [
            [5, rule.title],
            [3, rule.description ?? ''],
            [1, rule.body],
          ]),
        }))
        .filter((hit) => hit.score > 0)
        .toSorted(
          (a, b) =>
            b.score - a.score ||
            binary(b.rule.updatedAt, a.rule.updatedAt) ||
            binary(a.rule.id, b.rule.id),
        )
        .slice(0, limit)
        .map((hit) => ({ rule: clone(hit.rule), score: hit.score }))
    },
  }
}

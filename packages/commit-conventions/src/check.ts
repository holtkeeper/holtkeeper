import { compilePattern, hasBody, parseTitle, ticketKeys } from './title.ts'
import type {
  BranchRules,
  CommitRules,
  PatternRule,
  Problem,
  RuleSource,
  Ruleset,
} from './types.ts'

const severity = (source: RuleSource) => (source === 'history' ? 'warning' : 'error')

function patternProblems(patterns: readonly PatternRule[], text: string, what: string): Problem[] {
  return patterns.flatMap((rule) => {
    const regex = compilePattern(rule.pattern)
    if (!regex || regex.test(text) !== Boolean(rule.negative)) return []
    return [
      {
        message: `${what} ${rule.negative ? 'must not match' : 'must match'} \`${rule.pattern}\``,
        source: rule.source,
        severity: severity(rule.source),
      },
    ]
  })
}

function ticketMatches(pattern: string, text: string) {
  const regex = compilePattern(pattern)
  return regex ? regex.test(text) : ticketKeys(text).length > 0
}

/** The rules `message` breaks; an empty list means it follows every known rule. */
export function checkCommitMessage(ruleset: Ruleset<CommitRules>, message: string): Problem[] {
  const { rules, sources } = ruleset
  const problems = patternProblems(ruleset.patterns, message, 'The message')
  const add = (field: keyof CommitRules, text: string) => {
    const source = sources[field] ?? 'setting'
    problems.push({ message: text, source, severity: severity(source) })
  }
  const headline = message.split('\n')[0]?.trim() ?? ''
  const title = parseTitle(headline)

  if (rules.conventional && !title.type)
    add('conventional', 'The title must look like `type(scope): subject`')
  if (title.type && rules.types && !rules.types.includes(title.type))
    add('types', `Type \`${title.type}\` is not one of ${rules.types.join(', ')}`)
  if (title.scope && rules.scopes && !rules.scopes.includes(title.scope))
    add('scopes', `Scope \`${title.scope}\` is not one of ${rules.scopes.join(', ')}`)
  if (rules.scopeRequired && title.type && !title.scope)
    add('scopeRequired', 'The title needs a scope')
  if (rules.ticket?.required && !ticketMatches(rules.ticket.pattern, headline))
    add('ticket', `The title needs a ticket key matching \`${rules.ticket.pattern}\``)
  if (rules.maxLength && headline.length > rules.maxLength)
    add('maxLength', `The title has ${headline.length} characters; at most ${rules.maxLength}`)

  const subject = title.subject.replace(/^\[[^\]]*\]\s*/u, '')
  const first = /^\p{L}/u.exec(subject)?.[0]
  const acronym = /^[A-Z][A-Z0-9-]+\b/u.test(subject)
  if (first && !acronym && rules.subjectCase === 'lower' && first !== first.toLowerCase())
    add('subjectCase', 'Start the subject with a lowercase letter')
  if (first && rules.subjectCase === 'upper' && first !== first.toUpperCase())
    add('subjectCase', 'Start the subject with a capital letter')
  if (rules.noTrailingPeriod && headline.endsWith('.'))
    add('noTrailingPeriod', 'Drop the trailing period')
  if (rules.body === 'none' && hasBody(message)) add('body', 'Write the title only, without a body')
  if (rules.body === 'required' && !hasBody(message)) add('body', 'Add a body after a blank line')
  return problems
}

/** The rules the branch name `name` breaks. */
export function checkBranchName(ruleset: Ruleset<BranchRules>, name: string): Problem[] {
  const { rules, sources } = ruleset
  const problems = patternProblems(ruleset.patterns, name, 'The branch name')
  const add = (field: keyof BranchRules, text: string) => {
    const source = sources[field] ?? 'setting'
    problems.push({ message: text, source, severity: severity(source) })
  }
  const slash = name.indexOf('/')
  const prefix = slash > 0 ? name.slice(0, slash) : undefined
  if (rules.prefixes && (!prefix || !rules.prefixes.includes(prefix)))
    add('prefixes', `Start with one of ${rules.prefixes.map((p) => `\`${p}/\``).join(', ')}`)
  if (rules.ticket?.required && !ticketMatches(rules.ticket.pattern, name))
    add('ticket', `The name needs a ticket key matching \`${rules.ticket.pattern}\``)
  const rest = ticketKeys(name).reduce(
    (text, key) => text.replace(key, ''),
    prefix && rules.prefixes ? name.slice(slash + 1) : name,
  )
  if (rules.case === 'kebab' && !/^[a-z0-9/-]*$/u.test(rest))
    add('case', 'Use lowercase words joined by `-`')
  if (rules.case === 'snake' && !/^[a-z0-9/_]*$/u.test(rest))
    add('case', 'Use lowercase words joined by `_`')
  return problems
}

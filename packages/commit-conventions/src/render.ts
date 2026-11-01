import type {
  BranchRules,
  CommitConventions,
  Count,
  PatternRule,
  Problem,
  RuleSource,
  TicketPlacement,
} from './types.ts'

const sourceLabels: Record<RuleSource, string> = {
  setting: 'team setting',
  'push-rules': 'push rule, enforced by the forge',
  commitlint: 'commitlint',
  history: 'history',
}

const placements: Record<TicketPlacement, string> = {
  bracket: 'in brackets at the start of the subject: `[KEY-1] subject`',
  prefix: 'at the start of the subject: `KEY-1 subject`',
  scope: 'as the scope: `type(KEY-1): subject`',
  suffix: 'at the end: `subject (KEY-1)`',
  anywhere: 'anywhere in the title',
}

const percent = (value: number) => `${Math.round(value * 100)}%`

const top = (list: readonly Count[], limit = 12) =>
  list
    .slice(0, limit)
    .map((item) => `\`${item.name}\` (${item.count})`)
    .join(', ')

function line(text: string, source: RuleSource | undefined) {
  return `- ${text}${source ? ` _(${sourceLabels[source]})_` : ''}`
}

function patternLines(patterns: readonly PatternRule[], what: string) {
  return patterns.map((rule) =>
    line(
      `${what} ${rule.negative ? 'must not match' : 'must match'} \`${rule.pattern}\``,
      rule.source,
    ),
  )
}

function commitLines(conventions: CommitConventions): string[] {
  const { rules, sources, patterns } = conventions.commit
  const stats = conventions.history
  const lines: string[] = []
  if (rules.conventional)
    lines.push(
      line(
        `Conventional Commits: \`type(scope): subject\`${stats ? ` (${percent(stats.conventionalShare)} of the last ${stats.analyzed})` : ''}`,
        sources.conventional,
      ),
    )
  if (rules.types)
    lines.push(line(`Types: ${rules.types.map((t) => `\`${t}\``).join(', ')}`, sources.types))
  else if (rules.conventional && stats?.types.length)
    lines.push(line(`Types in use: ${top(stats.types)}`, 'history'))
  if (rules.scopes)
    lines.push(line(`Scopes: ${rules.scopes.map((s) => `\`${s}\``).join(', ')}`, sources.scopes))
  else if (rules.conventional && stats?.scopes.length)
    lines.push(line(`Scopes in use: ${top(stats.scopes)}`, 'history'))
  if (rules.scopeRequired) lines.push(line('A scope is required', sources.scopeRequired))
  if (rules.ticket)
    lines.push(
      line(
        `Ticket key \`${rules.ticket.pattern}\` ${rules.ticket.required ? 'required' : 'when there is one'}, ${placements[rules.ticket.placement ?? 'anywhere']}`,
        sources.ticket,
      ),
    )
  if (rules.maxLength)
    lines.push(line(`Title at most ${rules.maxLength} characters`, sources.maxLength))
  if (rules.subjectCase)
    lines.push(
      line(
        `Subject starts with a ${rules.subjectCase === 'lower' ? 'lowercase' : 'capital'} letter`,
        sources.subjectCase,
      ),
    )
  if (rules.noTrailingPeriod)
    lines.push(line('No period at the end of the title', sources.noTrailingPeriod))
  if (rules.body === 'none') lines.push(line('Title only, no body', sources.body))
  if (rules.body === 'required') lines.push(line('A body after a blank line', sources.body))
  return [...lines, ...patternLines(patterns, 'The whole message')]
}

function branchLines(rules: BranchRules, sources: CommitConventions['branch']['sources']) {
  const lines: string[] = []
  if (rules.prefixes)
    lines.push(
      line(`Prefix: ${rules.prefixes.map((p) => `\`${p}/\``).join(', ')}`, sources.prefixes),
    )
  if (rules.ticket)
    lines.push(
      line(
        `Ticket key \`${rules.ticket.pattern}\` ${rules.ticket.required ? 'required' : 'when there is one'}`,
        sources.ticket,
      ),
    )
  if (rules.case)
    lines.push(
      line(`Lowercase words joined by \`${rules.case === 'kebab' ? '-' : '_'}\``, sources.case),
    )
  return lines
}

function section(title: string, template: string | undefined, lines: string[], examples: string[]) {
  if (!template && !lines.length && !examples.length) return []
  return [
    `## ${title}`,
    '',
    ...(template ? [`Template: \`${template}\``, ''] : []),
    ...(lines.length ? [...lines, ''] : []),
    ...(examples.length ? ['Examples:', ...examples.map((example) => `- \`${example}\``), ''] : []),
  ]
}

/** Markdown for agents: templates, rules with their sources, examples and team notes. */
export function renderCommitConventions(conventions: CommitConventions): string {
  const { commit, branch } = conventions
  const body = [
    ...section('Commit messages', commit.rules.template, commitLines(conventions), commit.examples),
    ...section(
      'Branch names',
      branch.rules.template,
      [...branchLines(branch.rules, branch.sources), ...patternLines(branch.patterns, 'The name')],
      branch.examples,
    ),
    ...(conventions.notes ? ['## Team notes', '', conventions.notes, ''] : []),
  ]
  const consulted = conventions.consulted.map((item) => item.detail).join(', ')
  return [
    `# Commit conventions of ${conventions.repo}`,
    '',
    ...(body.length
      ? body
      : [
          'No rules found: no setting, push rules or commitlint config, and too little history.',
          '',
        ]),
    `Sources: ${consulted || 'none'}. Rules from history are what at least 80% of recent commits or branches do. Merge request titles usually follow the commit title rules. Call check_commit_message before committing.`,
  ].join('\n')
}

/** Markdown verdict of `check_commit_message`. */
export function renderProblems(results: { what: string; problems: Problem[] }[]): string {
  return results
    .map(({ what, problems }) =>
      problems.length
        ? [
            `${what}: ${problems.some((p) => p.severity === 'error') ? 'breaks rules' : 'unusual for this repository'}`,
            ...problems.map(
              (problem) =>
                `- ${problem.severity}: ${problem.message} _(${sourceLabels[problem.source]})_`,
            ),
          ].join('\n')
        : `${what}: follows every known rule.`,
    )
    .join('\n\n')
}

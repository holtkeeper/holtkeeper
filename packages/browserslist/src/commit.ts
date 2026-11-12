import {
  type CommitConventions,
  type CommitRules,
  type Problem,
  checkBranchName,
  checkCommitMessage,
} from '@holtkeeper/commit-conventions'

const subjects = [
  'update browserslist database to caniuse-lite {version}',
  'update caniuse-lite to {version}',
]

/** The commit message of an update, or why the update must not be pushed. */
export type BrowserslistCommit = { message: string } | { skipped: string }

const errorsOf = (problems: Problem[]) => problems.filter((problem) => problem.severity === 'error')

/** `build`, then `chore`, then the first allowed type; `chore` when any type goes. */
export function commitType(rules: Pick<CommitRules, 'types'>): string {
  const allowed = rules.types?.filter(Boolean)
  if (!allowed?.length) return 'chore'
  return ['build', 'chore'].find((type) => allowed.includes(type)) ?? allowed[0]!
}

const scopeOf = (rules: CommitRules) =>
  !rules.scopes || rules.scopes.includes('deps') ? 'deps' : undefined

const cased = (text: string, rules: CommitRules) =>
  rules.subjectCase === 'upper' ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text

function fromTemplate(template: string, type: string, scope: string | undefined, subject: string) {
  return template
    .replaceAll('<type>', type)
    .replaceAll('(<scope>)', scope ? `(${scope})` : '')
    .replaceAll('<scope>', scope ?? '')
    .replace(/\(<TICKET>\)|\[<TICKET>\]|<TICKET>:?/gu, '')
    .replaceAll('<subject>', subject)
    .replace(/\s+/gu, ' ')
    .trim()
}

function candidates(conventions: CommitConventions | undefined, configured: string | undefined) {
  const rules = conventions?.commit.rules ?? {}
  const type = commitType(rules)
  const scope = scopeOf(rules)
  const list = configured ? [configured] : []
  for (const raw of subjects) {
    const subject = cased(raw, rules)
    if (rules.template) list.push(fromTemplate(rules.template, type, scope, subject))
    if (scope) list.push(`${type}(${scope}): ${subject}`)
    list.push(`${type}: ${subject}`)
  }
  if (!rules.conventional)
    list.push(...subjects.map((raw) => `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`))
  return list
}

/**
 * The commit message (also the merge request title) of a database update to `version`: the first
 * of `configured`, the conventions' template and Conventional Commits titles (type `build`, else
 * `chore`, else the first allowed one) that breaks no error-level rule of `conventions`. When none
 * qualifies, for example because a ticket key is required, or when `branch` breaks a push rule the
 * forge enforces, `skipped` says why nothing may be pushed. Without conventions the first
 * candidate is taken.
 */
export function browserslistCommit(input: {
  version: string
  branch: string
  conventions?: CommitConventions | undefined
  configured?: string | undefined
}): BrowserslistCommit {
  const { conventions } = input
  const messages = candidates(conventions, input.configured).map((message) =>
    message.replaceAll('{version}', input.version).trim(),
  )
  const first = messages[0]!
  if (!conventions) return { message: first }
  const branchErrors = errorsOf(checkBranchName(conventions.branch, input.branch)).filter(
    (problem) => problem.source === 'push-rules',
  )
  if (branchErrors.length)
    return {
      skipped: `The forge's push rules reject branch \`${input.branch}\`: ${branchErrors.map((problem) => problem.message).join('; ')}. Set \`branch\` to a name they accept.`,
    }
  const message = messages.find(
    (text) => errorsOf(checkCommitMessage(conventions.commit, text)).length === 0,
  )
  if (message) return { message }
  const problems = errorsOf(checkCommitMessage(conventions.commit, first))
  const ticket = conventions.commit.rules.ticket
  if (problems.some((problem) => problem.rule === 'ticket') && ticket)
    return {
      skipped: `The repository's commit conventions require a ticket key matching \`${ticket.pattern}\` and an automatic database update has none. Set \`commitMessage\` with a ticket key to publish it.`,
    }
  return {
    skipped: `No commit message follows the repository's commit conventions: ${problems.map((problem) => problem.message).join('; ')}. Set \`commitMessage\` to one that does.`,
  }
}

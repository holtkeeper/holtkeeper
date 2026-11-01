import type { CommitRules } from './types.ts'

/** Files commitlint reads its config from, in its own lookup order. */
export const commitlintFiles = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
  '.commitlintrc.ts',
  '.commitlintrc.cts',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
  'commitlint.config.cts',
]

const conventionalTypes = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
]

const q = `['"]?`

/** `[level, 'always' | 'never', value]` of a rule written as a literal; level 0 disables it. */
function rule(text: string, name: string, value: string) {
  const match = new RegExp(
    `${q}${name}${q}\\s*:\\s*\\[\\s*([0-2])\\s*,\\s*${q}(always|never)${q}\\s*(?:,\\s*(${value}))?`,
    'u',
  ).exec(text)
  if (!match || match[1] === '0') return undefined
  return { when: match[2], value: match[3] }
}

const list = (value: string | undefined) =>
  value
    ?.replace(/^\[|\]$/gu, '')
    .split(',')
    .map((item) => item.trim().replace(/^['"`]|['"`]$/gu, ''))
    .filter(Boolean)

/**
 * Commit rules read from the text of a commitlint config without running it: whether it extends
 * `@commitlint/config-conventional`, and `type-enum`, `scope-enum`, `scope-empty`,
 * `header-max-length`, `subject-full-stop` and `body-empty` written as literals. Rules built in
 * code are not seen.
 */
export function parseCommitlint(text: string): CommitRules {
  const rules: CommitRules = {}
  if (/config-conventional|conventional-changelog/u.test(text)) {
    rules.conventional = true
    rules.types = conventionalTypes
    rules.maxLength = 100
    rules.noTrailingPeriod = true
  }
  const types = rule(text, 'type-enum', '\\[[^\\]]*\\]')
  if (types?.when === 'always' && list(types.value)?.length) {
    rules.conventional = true
    rules.types = list(types.value)
  }
  const scopes = rule(text, 'scope-enum', '\\[[^\\]]*\\]')
  if (scopes?.when === 'always' && list(scopes.value)?.length) rules.scopes = list(scopes.value)
  if (rule(text, 'scope-empty', '')?.when === 'never') rules.scopeRequired = true
  const length = rule(text, 'header-max-length', '\\d+')
  if (length?.value) rules.maxLength = Number(length.value)
  const stop = rule(text, 'subject-full-stop', `${q}\\.${q}`)
  if (stop) rules.noTrailingPeriod = stop.when === 'never'
  const body = rule(text, 'body-empty', '')
  if (body) rules.body = body.when === 'always' ? 'none' : 'required'
  return rules
}

/** The `commitlint` section of a `package.json`, as text for `parseCommitlint`. */
export function commitlintOfPackageJson(text: string): string | undefined {
  try {
    const section: unknown = Reflect.get(JSON.parse(text) ?? {}, 'commitlint')
    return section === undefined ? undefined : JSON.stringify(section)
  } catch {
    return undefined
  }
}

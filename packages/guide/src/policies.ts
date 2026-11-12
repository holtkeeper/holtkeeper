import type { RepoTarget } from '@holtkeeper/access'
import { assetsPolicyFacts, assetsPolicyKey, assetsPolicySchema } from '@holtkeeper/assets'
import {
  type CommitConventionsSetting,
  commitConventionsKey,
  commitConventionsSchema,
} from '@holtkeeper/commit-conventions'
import { resolveRepoTests, resolveSetting } from '@holtkeeper/settings'
import type { SettingEntry } from '@holtkeeper/store'
import { type TestIdOverrides, testIdOverridesOf } from '@holtkeeper/testids'

import type { GuidePolicy } from './resolve.ts'

const list = (items: readonly string[] | undefined) =>
  items?.length ? items.map((item) => `\`${item}\``).join(', ') : undefined

/** The `commits.conventions` setting as plain facts, one per line; empty when nothing is set. */
export function commitPolicyFacts(setting: CommitConventionsSetting): string {
  const commit = setting.commit
  const branch = setting.branch
  const facts = [
    commit?.template && `Commit message template: \`${commit.template}\`.`,
    commit?.conventional && 'Commit messages follow Conventional Commits.',
    list(commit?.types) && `Allowed commit types: ${list(commit?.types)}.`,
    list(commit?.scopes) &&
      `Allowed commit scopes: ${list(commit?.scopes)}${commit?.scopeRequired ? ' (required)' : ''}.`,
    commit?.ticket &&
      `Commit messages ${commit.ticket.required ? 'must' : 'may'} name a ticket matching \`${commit.ticket.pattern}\`${commit.ticket.placement ? ` (${commit.ticket.placement})` : ''}.`,
    commit?.maxLength && `Commit titles have at most ${commit.maxLength} characters.`,
    commit?.subjectCase && `Commit subjects start in ${commit.subjectCase} case.`,
    commit?.noTrailingPeriod && 'Commit titles do not end with a period.',
    commit?.body && `Commit message body: ${commit.body}.`,
    commit?.pattern && `Commit messages must match \`${commit.pattern}\`.`,
    commit?.forbidden && `Commit messages must not match \`${commit.forbidden}\`.`,
    branch?.template && `Branch name template: \`${branch.template}\`.`,
    list(branch?.prefixes) && `Branch prefixes: ${list(branch?.prefixes)}.`,
    branch?.case && `Branch names are ${branch.case} case.`,
    branch?.ticket &&
      `Branch names ${branch.ticket.required ? 'must' : 'may'} name a ticket matching \`${branch.ticket.pattern}\`.`,
    branch?.pattern && `Branch names must match \`${branch.pattern}\`.`,
  ].filter((fact): fact is string => typeof fact === 'string' && fact.length > 0)
  const notes = setting.notes?.trim()
  return [...facts.map((fact) => `- ${fact}`), ...(notes ? [notes] : [])].join('\n')
}

/** Setting key of the `testids` analyzer options, which also hold the team's test id overrides. */
export const testIdsSettingKey = 'analyzers.testids'

/** The test id overrides the `analyzers.testids` entry that applies to `repo` sets. */
export const testIdOverridesFor = (
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): TestIdOverrides => testIdOverridesOf(resolveSetting(entries, testIdsSettingKey, repo)?.value)

/** Test id overrides as plain facts, one per line; empty when the team set none. */
export function testIdPolicyFacts(overrides: TestIdOverrides): string {
  return [
    list(overrides.attributes) &&
      `Test ids use ${list(overrides.attributes)}; new ids use ${
        overrides.attributes?.length === 1
          ? `\`${overrides.attributes[0]}\``
          : `the one the repository already uses most (\`${overrides.attributes?.[0]}\` when it uses none)`
      }.`,
    list(overrides.elements) && `Elements that need a test id: ${list(overrides.elements)}.`,
    list(overrides.exclude) && `Files that need no test ids: ${list(overrides.exclude)}.`,
  ]
    .filter((fact): fact is string => typeof fact === 'string' && fact.length > 0)
    .map((fact) => `- ${fact}`)
    .join('\n')
}

const noTestsPolicyFact = (reason?: string) =>
  `- This repository has no tests by design${reason ? ` (${reason})` : ''}: do not add test files, test frameworks or test scripts, do not run tests, and do not ask for tests in reviews.`

/**
 * Policies of `repo` from settings, rendered as plain facts: commit conventions, test ids, the
 * asset policy when an `assets.policy` entry covers the repository, and a `general` line when
 * `repo.tests` says it has no tests by design.
 */
export function policiesFor(entries: readonly SettingEntry[], repo: RepoTarget): GuidePolicy[] {
  const parsed = commitConventionsSchema.safeParse(
    resolveSetting(entries, commitConventionsKey, repo)?.value,
  )
  const commits = parsed.success ? commitPolicyFacts(parsed.data) : ''
  const testids = testIdPolicyFacts(testIdOverridesFor(entries, repo))
  const assetsEntry = resolveSetting(entries, assetsPolicyKey, repo)
  const assetsPolicy = assetsEntry && assetsPolicySchema.safeParse(assetsEntry.value)
  const assets = assetsPolicy?.success ? assetsPolicyFacts(assetsPolicy.data) : ''
  const tests = resolveRepoTests(entries, repo)
  return [
    ...(tests.expected
      ? []
      : [{ section: 'general' as const, text: noTestsPolicyFact(tests.reason) }]),
    ...(testids ? [{ section: 'testids' as const, text: testids }] : []),
    ...(assets ? [{ section: 'assets' as const, text: assets }] : []),
    ...(commits ? [{ section: 'commits' as const, text: commits }] : []),
  ]
}

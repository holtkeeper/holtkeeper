import type { GitForge, PushRules } from '@holtkeeper/forge'

import { checkBranchName, checkCommitMessage } from './check.ts'
import { commitlintFiles, commitlintOfPackageJson, parseCommitlint } from './commitlint.ts'
import {
  type HistoryBranch,
  type HistoryCommit,
  commitTemplate,
  inferBranchRules,
  inferCommitRules,
} from './infer.ts'
import type { CommitConventionsSetting } from './setting.ts'
import type {
  BranchRules,
  CommitConventions,
  CommitRules,
  Consulted,
  PatternRule,
  RuleSource,
  Ruleset,
} from './types.ts'

/** The forge reads conventions need; every optional one is skipped when missing. */
export type ConventionsForge = Pick<
  GitForge,
  'getRepository' | 'readFile' | 'listFiles' | 'listCommits' | 'listBranches' | 'getPushRules'
>

/** Inputs of `commitConventions`. */
export interface CommitConventionsInput {
  forge: ConventionsForge
  /** Path of the repository on the forge. */
  repo: string
  /** How `repo` is named in the result; default `repo`. */
  label?: string
  /** The `commits.conventions` value that applies to the repository. */
  setting?: CommitConventionsSetting
  /** How many commits of the default branch to analyze. Default 100. */
  commits?: number
}

interface Layer<Rules> {
  source: RuleSource
  rules: Rules
}

function merge<Rules extends object>(
  layers: readonly Layer<Rules>[],
  patterns: PatternRule[],
): Ruleset<Rules> {
  const rules: Partial<Rules> = {}
  const sources: Partial<Record<keyof Rules, RuleSource>> = {}
  for (const layer of layers)
    for (const [field, value] of Object.entries(layer.rules)) {
      if (value === undefined || Reflect.has(rules, field)) continue
      Reflect.set(rules, field, value)
      Reflect.set(sources, field, layer.source)
    }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every field of Rules is optional
  return { rules: rules as Rules, sources, patterns, examples: [] }
}

const settled = async <T>(work: Promise<T> | undefined): Promise<T | undefined> => {
  try {
    return await work
  } catch {
    return undefined
  }
}

async function readCommitlint(forge: ConventionsForge, repo: string, ref: string) {
  const root = await settled(forge.listFiles?.(repo, { ref }))
  const present = new Set(root?.filter((entry) => entry.type === 'file').map((entry) => entry.path))
  const candidates = root ? commitlintFiles.filter((file) => present.has(file)) : commitlintFiles
  for (const file of candidates) {
    const text = await settled(forge.readFile(repo, file, ref))
    if (text !== undefined) return { file, text }
  }
  if (root && !present.has('package.json')) return undefined
  const pkg = await settled(forge.readFile(repo, 'package.json', ref))
  const section = pkg === undefined ? undefined : commitlintOfPackageJson(pkg)
  return section === undefined ? undefined : { file: 'package.json', text: section }
}

function pushPatterns(rules: PushRules | undefined) {
  const commit: PatternRule[] = []
  const branch: PatternRule[] = []
  if (rules?.commitMessage) commit.push({ source: 'push-rules', pattern: rules.commitMessage })
  if (rules?.commitMessageNegative)
    commit.push({ source: 'push-rules', pattern: rules.commitMessageNegative, negative: true })
  if (rules?.branchName) branch.push({ source: 'push-rules', pattern: rules.branchName })
  return { commit, branch }
}

function settingRules(setting: CommitConventionsSetting | undefined) {
  const { pattern, forbidden, examples, ...commit } = setting?.commit ?? {}
  const { pattern: branchPattern, examples: branchExamples, ...branch } = setting?.branch ?? {}
  const commitPatterns: PatternRule[] = [
    ...(pattern ? [{ source: 'setting' as const, pattern }] : []),
    ...(forbidden ? [{ source: 'setting' as const, pattern: forbidden, negative: true }] : []),
  ]
  const branchPatterns: PatternRule[] = branchPattern
    ? [{ source: 'setting', pattern: branchPattern }]
    : []
  return {
    commit: commit satisfies CommitRules,
    branch: branch satisfies BranchRules,
    commitPatterns,
    branchPatterns,
    commitExamples: examples ?? [],
    branchExamples: branchExamples ?? [],
  }
}

const clean = (examples: Iterable<string>, limit: number) => [...new Set(examples)].slice(0, limit)

/**
 * The commit and branch conventions of a repository: the setting first, then the forge's push
 * rules, the commitlint config of the default branch, and rules inferred from its recent commits
 * and branches (unless the setting turns history off). Sources the forge cannot read are skipped,
 * so the result may be empty. Examples are the setting's, then real titles and branch names that
 * break no rule, newest first.
 */
export async function commitConventions(input: CommitConventionsInput): Promise<CommitConventions> {
  const { forge, repo, setting } = input
  const limit = input.commits ?? 100
  const history = setting?.history ?? true
  const repository = await forge.getRepository(repo)
  const ref = repository.defaultBranch

  const [pushRules, commitlint, commits, branches] = await Promise.all([
    settled(forge.getPushRules?.(repo)),
    readCommitlint(forge, repo, ref),
    history ? settled(forge.listCommits?.(repo, { ref, limit })) : undefined,
    history ? settled(forge.listBranches?.(repo)) : undefined,
  ])

  const consulted: Consulted[] = []
  const configured = settingRules(setting)
  if (setting) consulted.push({ source: 'setting', detail: 'commits.conventions setting' })
  const push = pushPatterns(pushRules)
  if (pushRules) consulted.push({ source: 'push-rules', detail: 'push rules of the forge' })
  const linted = commitlint ? parseCommitlint(commitlint.text) : {}
  if (commitlint) consulted.push({ source: 'commitlint', detail: commitlint.file })

  const inferredCommits = inferCommitRules((commits ?? []) satisfies HistoryCommit[])
  const inferredBranches = inferBranchRules((branches ?? []) satisfies HistoryBranch[])
  if (commits)
    consulted.push({ source: 'history', detail: `last ${commits.length} commits on ${ref}` })
  if (branches)
    consulted.push({ source: 'history', detail: `${inferredBranches.analyzed} branches` })

  const commit = merge<CommitRules>(
    [
      { source: 'setting', rules: configured.commit },
      { source: 'commitlint', rules: linted },
      { source: 'history', rules: inferredCommits.rules },
    ],
    [...configured.commitPatterns, ...push.commit],
  )
  if (commit.sources.template !== 'setting') {
    delete commit.rules.template
    delete commit.sources.template
    if (commit.rules.conventional || commit.rules.ticket) {
      commit.rules.template = commitTemplate(commit.rules)
      commit.sources.template = commit.sources.conventional ?? commit.sources.ticket ?? 'history'
    }
  }
  const branch = merge<BranchRules>(
    [
      { source: 'setting', rules: configured.branch },
      { source: 'history', rules: inferredBranches.rules },
    ],
    [...configured.branchPatterns, ...push.branch],
  )

  commit.examples = clean(
    [
      ...configured.commitExamples,
      ...(commits ?? [])
        .filter((record) => record.parents.length < 2)
        .filter((record) => checkCommitMessage(commit, record.message).length === 0)
        .map((record) => record.title),
    ],
    8,
  )
  branch.examples = clean(
    [
      ...configured.branchExamples,
      ...(branches ?? [])
        .filter((record) => !record.default && !record.protected)
        .toSorted((a, b) => b.committedAt.localeCompare(a.committedAt))
        .filter((record) => checkBranchName(branch, record.name).length === 0)
        .map((record) => record.name),
    ],
    5,
  )

  return {
    repo: input.label ?? repo,
    commit,
    branch,
    ...(setting?.notes?.trim() ? { notes: setting.notes.trim() } : {}),
    ...(commits
      ? {
          history: {
            ref,
            commits: commits.length,
            analyzed: inferredCommits.analyzed,
            conventionalShare: inferredCommits.conventionalShare,
            ticketShare: inferredCommits.ticketShare,
            types: inferredCommits.types,
            scopes: inferredCommits.scopes,
            branches: inferredBranches.analyzed,
          },
        }
      : {}),
    consulted,
  }
}

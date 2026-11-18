import type { RuleAgent } from '@holtkeeper/store'

import { globList, parseFrontmatter } from './frontmatter.ts'

/**
 * How a repository rules file reaches a prompt: `always`, when the task touches a file matching
 * its `globs` (`files`), or offered to agents by its `description` (`requested`).
 */
export type RepoRuleKind = 'always' | 'files' | 'requested'

/** A rules file of a repository, parsed. */
export interface RepoRuleFile {
  /** Repository-relative path. */
  path: string
  /** The Markdown body, frontmatter removed. */
  text: string
  kind: RepoRuleKind
  /** Path globs for `files`; empty otherwise. */
  globs: string[]
  /** Agent runs that read it; absent: every one. */
  agents?: RuleAgent[]
  description?: string
}

/** Rules files at the repository root that always apply, in the order agents read them. */
export const ROOT_RULE_FILES = [
  'REVIEW.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  'CONTRIBUTING.md',
] as const

/** Most rules files read from one repository. */
export const MAX_RULE_FILES = 60

const NESTED = new Set(['AGENTS.md', 'CLAUDE.md'])
const SKIPPED_DIRS = /(?:^|\/)(?:node_modules|vendor|dist|build|\.git)\//

const DIRECTORY_RULES: { prefix: string; test: RegExp }[] = [
  { prefix: '.github/instructions/', test: /\.instructions\.md$/ },
  { prefix: '.cursor/rules/', test: /\.mdc?$/ },
  { prefix: '.claude/rules/', test: /\.md$/ },
  { prefix: '.windsurf/rules/', test: /\.md$/ },
  { prefix: '.continue/rules/', test: /\.md$/ },
]

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** Whether `path` (repository-relative) is a rules file Holtkeeper reads. */
export function isRuleFilePath(path: string): boolean {
  if (SKIPPED_DIRS.test(path)) return false
  if ((ROOT_RULE_FILES as readonly string[]).includes(path)) return true
  if (NESTED.has(baseName(path))) return true
  return DIRECTORY_RULES.some((rule) => path.startsWith(rule.prefix) && rule.test.test(path))
}

const rootRank = (path: string) => {
  const index = (ROOT_RULE_FILES as readonly string[]).indexOf(path)
  return index === -1 ? ROOT_RULE_FILES.length : index
}

/**
 * The rules files among `paths` (a repository listing), at most `MAX_RULE_FILES`: root files in
 * `ROOT_RULE_FILES` order, then nested and directory files by path.
 */
export function ruleFilePaths(paths: readonly string[]): string[] {
  return paths
    .filter(isRuleFilePath)
    .toSorted((a, b) => rootRank(a) - rootRank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_RULE_FILES)
}

const ALL_FILES = new Set(['**', '**/*', '*'])

const filesOrAlways = (
  globs: string[],
  fallback: RepoRuleKind | undefined,
): { kind: RepoRuleKind; globs: string[] } | undefined => {
  if (globs.some((glob) => ALL_FILES.has(glob))) return { kind: 'always', globs: [] }
  if (globs.length) return { kind: 'files', globs }
  return fallback && { kind: fallback, globs: [] }
}

const copilotAgents = (value: unknown): RuleAgent[] | undefined => {
  if (value === 'code-review') return ['task', 'chat', 'release']
  if (value === 'coding-agent' || value === 'cloud-agent') return ['review', 'chat', 'release']
  return undefined
}

/**
 * Parses one rules file. Root files always apply; a nested `AGENTS.md` or `CLAUDE.md` applies to
 * files under its folder; `.github/instructions` files follow `applyTo` and `excludeAgent`;
 * Cursor, Continue and Claude Code rules follow `alwaysApply`, `globs` / `paths` and
 * `description`; Windsurf rules follow `trigger`. A file that applies only when someone mentions
 * it by hand, or whose body is blank, returns `undefined`.
 */
export function parseRuleFile(path: string, text: string): RepoRuleFile | undefined {
  const { data, body } = parseFrontmatter(text)
  if (!body) return undefined
  const description = typeof data.description === 'string' && data.description.trim()
  const withDescription = description ? { description } : {}
  const make = (
    placement: { kind: RepoRuleKind; globs: string[] } | undefined,
    agents?: RuleAgent[],
  ) =>
    placement && {
      path,
      text: body,
      ...placement,
      ...(agents && { agents }),
      ...withDescription,
    }

  if ((ROOT_RULE_FILES as readonly string[]).includes(path))
    return make({ kind: 'always', globs: [] })
  if (NESTED.has(baseName(path)) && !DIRECTORY_RULES.some((rule) => path.startsWith(rule.prefix))) {
    return make({ kind: 'files', globs: [`${dirName(path)}/**`] })
  }
  const requested = description ? 'requested' : undefined
  if (path.startsWith('.github/instructions/')) {
    return make(filesOrAlways(globList(data.applyTo), requested), copilotAgents(data.excludeAgent))
  }
  if (path.startsWith('.claude/rules/')) return make(filesOrAlways(globList(data.paths), 'always'))
  if (path.startsWith('.windsurf/rules/')) {
    const trigger = data.trigger
    if (trigger === 'always_on') return make({ kind: 'always', globs: [] })
    if (trigger === 'glob') return make(filesOrAlways(globList(data.globs), undefined))
    if (trigger === 'model_decision') return make(requested && { kind: 'requested', globs: [] })
    return undefined
  }
  if (data.alwaysApply === true) return make({ kind: 'always', globs: [] })
  return make(filesOrAlways(globList(data.globs), requested))
}

/** Where `readRepoRules` gets a repository's files: a listing and a reader. */
export interface RuleFileSource {
  /** Every repository-relative file path, or at least every rules file. */
  paths: readonly string[]
  read(path: string): Promise<string | undefined>
}

/** Reads and parses the rules files of a repository, in `ruleFilePaths` order. */
export async function readRepoRules(source: RuleFileSource): Promise<RepoRuleFile[]> {
  const paths = ruleFilePaths(source.paths)
  const texts = await Promise.all(paths.map((path) => source.read(path)))
  return paths.flatMap((path, index) => {
    const text = texts[index]
    const parsed = text === undefined ? undefined : parseRuleFile(path, text)
    return parsed ? [parsed] : []
  })
}

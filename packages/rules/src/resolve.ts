import { type RepoTarget, type Scope, scopeSpecificity } from '@holtkeeper/access'
import type { Learning, Rule, RuleAgent } from '@holtkeeper/store'

import { byLearningRank, learningApplies } from './learnings.ts'
import { filesMatch, type RuleActivation, ruleActivation, ruleApplies } from './model.ts'
import type { RepoRuleFile } from './repo-files.ts'

/** Character limits of a resolved prompt block. */
export interface RuleBudget {
  /** Everything together. */
  total: number
  /** Repository rules files together. */
  repoFiles: number
  /** Learned rules together. */
  learnings: number
}

export const DEFAULT_RULE_BUDGET: RuleBudget = { total: 12_000, repoFiles: 4_800, learnings: 3_000 }

/** Plain facts from settings (commit conventions, test ids, asset policy) for one agent run. */
export interface RulePolicy {
  title: string
  text: string
}

export interface ResolveRulesInput {
  repo: RepoTarget
  agent: RuleAgent
  /**
   * Repository-relative paths the task touches, e.g. a merge request's changed files. Absent:
   * every file-scoped rule is included with the paths it applies to.
   */
  files?: readonly string[]
  rules: readonly Rule[]
  repoFiles: readonly RepoRuleFile[]
  /** Learnings in any status; only active ones that apply are used. */
  learnings: readonly Learning[]
  policies?: readonly RulePolicy[]
  /** Names a team key in sources; default the key itself. */
  teamTitle?: (key: string) => string
  budget?: Partial<RuleBudget>
}

export type RuleLayer = 'rule' | 'repo-file' | 'policy' | 'learning'

/** One block the resolver considered: what it would take whole and what it got. */
export interface RuleBlock {
  layer: RuleLayer
  /** Rule id, repository file path, `policy:<title>` or learning id. */
  id: string
  title: string
  /** Where it comes from in words: `All repositories`, `Team widgets`, `pkg/AGENTS.md`, … */
  source: string
  activation: RuleActivation
  globs?: string[]
  /** The block as the prompt has it; empty when left out. */
  text: string
  chars: number
  fullChars: number
  cut: boolean
}

/** A rule offered to agents by its description instead of injected. */
export interface RequestedRule {
  id: string
  title: string
  description: string
  source: string
}

export interface ResolvedRules {
  /** The prompt block; empty when nothing applies. */
  text: string
  /** In prompt order, including blocks left out for room. */
  blocks: RuleBlock[]
  requested: RequestedRule[]
  /** Problems a person should see, e.g. rules cut for room. */
  warnings: string[]
  budget: RuleBudget & { used: number }
}

/** Opens every non-empty resolved block. */
export const RULES_HEADER =
  "## Team rules\nRules this repository's team follows. Cite a rule you apply as [rule:<id>] and a learned rule as [learn:<id>]."

export const LEARNED_HEADER =
  '### Learned rules\nLearned from past reviews; follow them unless a rule above says otherwise.'

const MARKER = '\n[...]'
const MIN_PIECE = 200

/** `text` cut at a line break to at most `max` characters, ended with `marker`. */
export function cutText(text: string, max: number, marker = MARKER): string {
  if (text.length <= max) return text
  const room = max - marker.length
  if (room <= 0) return ''
  const cut = text.lastIndexOf('\n', room)
  return `${text.slice(0, cut > room / 2 ? cut : room)}${marker}`
}

/** Describes a scope in words for a block's source. */
export function scopeSource(
  scope: Scope,
  teamTitle: (key: string) => string = (key) => key,
): string {
  if (scope.all) return 'All repositories'
  const parts = [
    ...(scope.teams?.length ? [`Team ${scope.teams.map(teamTitle).join(', ')}`] : []),
    ...(scope.repos?.length ? [`Repositories ${scope.repos.join(', ')}`] : []),
  ]
  return parts.join(' · ') || 'No repositories'
}

/** Words a kind of file brings to mind, so a rule about them ranks up for such a file. */
const EXTENSION_WORDS: Readonly<Record<string, readonly string[]>> = {
  tsx: ['component', 'react', 'jsx', 'props', 'hook', 'styled'],
  jsx: ['component', 'react', 'jsx', 'props', 'hook'],
  ts: ['typescript', 'type'],
  go: ['go', 'golang', 'package'],
  css: ['style', 'css', 'class'],
  scss: ['style', 'css', 'class'],
  png: ['image', 'asset', 'webp'],
  jpg: ['image', 'asset', 'webp'],
  jpeg: ['image', 'asset', 'webp'],
  svg: ['svg', 'icon', 'asset'],
  json: ['config', 'json'],
}

const IGNORED_WORDS = new Set(['src', 'index', 'lib', 'app', 'main', 'internal', 'pkg', 'cmd'])

/** The words of the paths a task touches: folders, file names (camel case split) and kinds. */
function fileWords(files: readonly string[]): Set<string> {
  const words = new Set<string>()
  for (const file of files) {
    const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase()
    for (const word of EXTENSION_WORDS[extension ?? ''] ?? []) words.add(word)
    if (/\.(test|spec)\./.test(file) || file.includes('__tests__')) words.add('test')
    for (const part of file.replace(/\.[^/.]+$/, '').split(/[/._-]+/))
      for (const word of part.split(/(?<=[a-z0-9])(?=[A-Z])/))
        if (word.length >= 3 && !IGNORED_WORDS.has(word.toLowerCase()))
          words.add(word.toLowerCase())
  }
  return words
}

/** How many of `words` a learned rule mentions. */
const mentionedWords = (learning: Learning, words: ReadonlySet<string>) => {
  const text = `${learning.text} ${learning.reason ?? ''}`.toLowerCase()
  let count = 0
  for (const word of words) if (text.includes(word)) count += 1
  return count
}

const appliesTo = (globs: readonly string[] | undefined, files: readonly string[] | undefined) =>
  globs?.length && files === undefined
    ? ` (applies to ${globs.map((glob) => `\`${glob}\``).join(', ')})`
    : ''

interface Candidate extends Omit<RuleBlock, 'text' | 'chars' | 'cut'> {
  full: string
  marker?: string
}

const byScope = (a: Rule, b: Rule) =>
  scopeSpecificity(a.scope) - scopeSpecificity(b.scope) ||
  (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
  (a.id < b.id ? -1 : 1)

/**
 * The rules an agent run on `repo` follows, as one prompt block, strongest first: panel rules
 * that always apply (organization, then teams, then repository patterns), the repository's root
 * rules files, file-scoped rules from the panel and the repository that match the touched files,
 * policies, then active learnings ranked by how they proved themselves. Learnings get at most
 * `budget.learnings` and rules files `budget.repoFiles`; when the total runs out later blocks are
 * cut at a line break, and blocks with less than 200 characters of room are left out. Learnings
 * are dropped whole, never cut mid-sentence. Rules that only have a description go to
 * `requested`. Pure and deterministic: the same inputs give the same text in any input order.
 */
export function resolveRules(input: ResolveRulesInput): ResolvedRules {
  const budget = { ...DEFAULT_RULE_BUDGET, ...input.budget }
  const teamTitle = input.teamTitle ?? ((key: string) => key)
  const files = input.files
  const applying = input.rules
    .filter((rule) => ruleApplies(rule, input.repo, input.agent))
    .toSorted(byScope)
  const requested: RequestedRule[] = []
  const always: Candidate[] = []
  const scoped: Candidate[] = []

  for (const rule of applying) {
    const activation = ruleActivation(rule)
    const source = scopeSource(rule.scope, teamTitle)
    if (activation === 'requested') {
      requested.push({
        id: rule.id,
        title: rule.title,
        description: rule.description ?? '',
        source,
      })
      continue
    }
    if (activation === 'files' && files !== undefined && !filesMatch(rule.files ?? [], files))
      continue
    const candidate: Candidate = {
      layer: 'rule',
      id: rule.id,
      title: rule.title,
      source,
      activation,
      ...(rule.files?.length && { globs: rule.files }),
      fullChars: 0,
      full: `### ${rule.title} [rule:${rule.id}]${appliesTo(rule.files, files)}\n${rule.body.trim()}`,
    }
    ;(activation === 'always' ? always : scoped).push(candidate)
  }

  const rootFiles: Candidate[] = []
  const scopedFiles: Candidate[] = []
  for (const file of input.repoFiles) {
    if (file.agents && !file.agents.includes(input.agent)) continue
    if (file.kind === 'requested') {
      requested.push({
        id: file.path,
        title: file.path,
        description: file.description ?? '',
        source: file.path,
      })
      continue
    }
    if (file.kind === 'files' && files !== undefined && !filesMatch(file.globs, files)) continue
    const candidate: Candidate = {
      layer: 'repo-file',
      id: file.path,
      title: file.path,
      source: file.path,
      activation: file.kind,
      ...(file.globs.length && { globs: file.globs }),
      fullChars: 0,
      full: `### ${file.path}${appliesTo(file.globs, files)}\n${file.text.trim()}`,
      marker: `\n[… truncated, see ${file.path}]`,
    }
    ;(file.kind === 'always' ? rootFiles : scopedFiles).push(candidate)
  }

  const policies: Candidate[] = (input.policies ?? [])
    .filter((policy) => policy.text.trim())
    .map((policy) => ({
      layer: 'policy',
      id: `policy:${policy.title}`,
      title: policy.title,
      source: 'Settings',
      activation: 'always',
      fullChars: 0,
      full: `### ${policy.title}\n${policy.text.trim()}`,
    }))

  const blocks: RuleBlock[] = []
  const warnings: string[] = []
  let used = 0
  let repoFilesUsed = 0
  const place = (candidate: Candidate) => {
    const { full, marker, ...rest } = candidate
    const layerRoom = candidate.layer === 'repo-file' ? budget.repoFiles - repoFilesUsed : Infinity
    const room = Math.min(budget.total - used, layerRoom)
    let text = full
    if (full.length > room) text = room >= MIN_PIECE ? cutText(full, room, marker) : ''
    const cut = text.length < full.length
    blocks.push({ ...rest, fullChars: full.length, text, chars: text.length, cut })
    used += text.length
    if (candidate.layer === 'repo-file') repoFilesUsed += text.length
    if (cut)
      warnings.push(
        `${candidate.title} ${text ? 'was cut' : 'was left out'} to fit the ${budget.total.toLocaleString('en')}-character budget.`,
      )
  }
  for (const candidate of [...always, ...rootFiles, ...scoped, ...scopedFiles, ...policies])
    place(candidate)

  const words = files ? fileWords(files) : undefined
  const relevance = (learning: Learning) =>
    words ? (learning.files?.length ? 100 : 0) + mentionedWords(learning, words) : 0
  const learned = input.learnings
    .filter((learning) => learningApplies(learning, input.repo, input.agent, files))
    .toSorted((a, b) => relevance(b) - relevance(a) || byLearningRank(a, b))
  if (learned.length) {
    const room = Math.min(budget.learnings, budget.total - used)
    const lines: string[] = []
    let length = LEARNED_HEADER.length
    const fullLength =
      LEARNED_HEADER.length +
      learned.reduce((sum, learning) => sum + learningLine(learning).length + 1, 0)
    for (const learning of learned) {
      const line = learningLine(learning)
      if (length + line.length + 1 > room) break
      lines.push(line)
      length += line.length + 1
    }
    const text = lines.length ? [LEARNED_HEADER, ...lines].join('\n') : ''
    const cut = lines.length < learned.length
    blocks.push({
      layer: 'learning',
      id: 'learnings',
      title: 'Learned rules',
      source: `${lines.length} of ${learned.length} learned rules`,
      activation: 'always',
      text,
      chars: text.length,
      fullChars: fullLength,
      cut,
    })
    used += text.length
    if (cut)
      warnings.push(
        `${learned.length - lines.length} learned rules were left out for room${words ? ', those least about the files touched first' : ''}; search_knowledge finds them by topic.`,
      )
  }

  const parts = blocks.map((block) => block.text).filter(Boolean)
  return {
    text: parts.length ? [RULES_HEADER, ...parts].join('\n\n') : '',
    blocks,
    requested,
    warnings,
    budget: { ...budget, used },
  }
}

const learningLine = (learning: Learning) => `- ${learning.text} [learn:${learning.id}]`

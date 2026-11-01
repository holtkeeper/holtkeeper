/**
 * Where a rule comes from, strongest first: the `commits.conventions` setting, the forge's push
 * rules, the repository's commitlint config, or what the recent history shows.
 */
export type RuleSource = 'setting' | 'push-rules' | 'commitlint' | 'history'

/** Where a ticket key sits in a commit title. */
export type TicketPlacement = 'bracket' | 'prefix' | 'scope' | 'suffix' | 'anywhere'

/** A tracker key such as `GTW-435`. */
export interface TicketRule {
  /** Regular expression source matching one key, e.g. `GTW-\d+`. */
  pattern: string
  required: boolean
  /** Commit titles only. */
  placement?: TicketPlacement
}

/** Rules for commit messages; absent fields are not required. */
export interface CommitRules {
  /** Titles follow Conventional Commits: `type(scope)!: subject`. */
  conventional?: boolean
  /** Allowed types. */
  types?: string[]
  /** Allowed scopes. */
  scopes?: string[]
  scopeRequired?: boolean
  ticket?: TicketRule
  /** Longest title in characters. */
  maxLength?: number
  /** Case of the subject's first letter. */
  subjectCase?: 'lower' | 'upper'
  noTrailingPeriod?: boolean
  /** `none`: the title is the whole message. */
  body?: 'none' | 'optional' | 'required'
  /** Shape of a title with `<type>`, `<scope>`, `<TICKET>` and `<subject>` placeholders. */
  template?: string
}

/** Rules for branch names; absent fields are not required. */
export interface BranchRules {
  /** Names start with one of these followed by `/`. */
  prefixes?: string[]
  ticket?: TicketRule
  /** Case of the part after the prefix, ticket keys aside. */
  case?: 'kebab' | 'snake'
  /** Shape of a name with `<prefix>`, `<TICKET>` and `<description>` placeholders. */
  template?: string
}

/** A regular expression the whole commit message or branch name must (or must not) match. */
export interface PatternRule {
  source: RuleSource
  /** Expression source as configured; `(?i)` at the start means case-insensitive. */
  pattern: string
  /** The text must not match. */
  negative?: boolean
}

/** Rules of one kind of name with where each came from. */
export interface Ruleset<Rules> {
  rules: Rules
  /** The source of every field set in `rules`. */
  sources: Partial<Record<keyof Rules, RuleSource>>
  patterns: PatternRule[]
  /** Real or configured names that pass every rule, newest first. */
  examples: string[]
}

/** How often a value appears in the analyzed history. */
export interface Count {
  name: string
  count: number
}

/** What the recent history of the default branch shows. */
export interface HistoryStats {
  ref: string
  /** Commits read. */
  commits: number
  /** Commits analyzed: merges, reverts and WIP commits are left out. */
  analyzed: number
  /** Share of analyzed titles in Conventional Commits form, 0–1. */
  conventionalShare: number
  /** Share of analyzed titles with a ticket key, 0–1. */
  ticketShare: number
  types: Count[]
  scopes: Count[]
  /** Branches analyzed: the default and protected ones are left out. */
  branches: number
}

/** A source that was found and read, for the reader to judge the rules. */
export interface Consulted {
  source: RuleSource
  /** E.g. `commitlint.config.ts` or `last 100 commits on main`. */
  detail: string
}

/** Everything known about how a repository names commits and branches. */
export interface CommitConventions {
  /** `forge:path` or the forge path, as given. */
  repo: string
  commit: Ruleset<CommitRules>
  branch: Ruleset<BranchRules>
  /** Free-form guidance from the setting, in Markdown. */
  notes?: string
  history?: HistoryStats
  consulted: Consulted[]
}

/** One rule a commit message or branch name breaks. */
export interface Problem {
  message: string
  source: RuleSource
  /** Rules seen in history only are `warning`; configured and enforced rules are `error`. */
  severity: 'error' | 'warning'
}

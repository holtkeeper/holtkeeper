/** A person as git records them. */
export interface Person {
  name: string
  email: string
}

/** A tag or other ref a changelog starts or ends at. */
export interface ReleaseRef {
  /** Tag name, or the ref as given when it is not a tag (e.g. `HEAD`, a branch). */
  name: string
  /** Commit the ref points to. */
  sha: string
  /** ISO 8601. Tagger date for annotated tags, committer date otherwise. */
  date: string
  /** Message of an annotated tag; absent for lightweight tags and plain refs. */
  message?: string
  /**
   * Every tag on the commit when the release is a monorepo release: a commit carrying package
   * tags (`@scope/name@1.2.3`). `name` is then the commit sha.
   */
  tags?: string[]
}

/** One package a monorepo release published. */
export interface PackageRelease {
  name: string
  version: string
  tag: string
  /** The package's version before this one, when an older tag of it exists. */
  previous?: string
}

/** Lines and files touched by a commit or a range. */
export interface DiffStat {
  files: number
  insertions: number
  deletions: number
}

/** How a file changed between two refs. */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/** One file in the net diff of a range. */
export interface ChangedFile {
  /** Path at `to`; for deleted files, the path at `from`. */
  path: string
  /** Zero for binary files. */
  insertions: number
  deletions: number
  status?: FileStatus
  /** Path at `from` for renames and copies. */
  previousPath?: string
  binary?: boolean
}

/** One commit as the history source reports it, before any interpretation. */
export interface CommitInfo {
  sha: string
  /** Parent shas; two or more for merge commits. */
  parents: string[]
  author: Person
  /** Author date, ISO 8601. */
  date: string
  subject: string
  /** Everything after the subject line, trimmed; may be empty. */
  body: string
  /** Changes against the first parent; zeros for merge commits. */
  stats: DiffStat
}

/** Range of commits: reachable from `to` and not from `from`. Without `from`, all of `to`'s history. */
export interface CommitRange {
  from?: string
  to: string
}

/**
 * Where release history comes from. The git CLI implementation is `gitHistory`; a forge API
 * source can implement the same contract.
 */
export interface HistorySource {
  /**
   * Tags, newest first: by semantic version when every tag name is a version (`v1.2.3`,
   * `1.2.3-rc.1`), by date otherwise.
   */
  listRefs(dir: string): Promise<ReleaseRef[]>
  /** Resolves any ref (tag, branch, sha, `HEAD`) to the commit it points to. */
  resolve(dir: string, ref: string): Promise<ReleaseRef>
  /** Commits of the range, newest first. */
  commits(dir: string, range: CommitRange): Promise<CommitInfo[]>
  /** Net change of the range (files counted once); optional for sources that cannot tell. */
  diffStat?(dir: string, range: CommitRange): Promise<DiffStat>
  /** Files that differ between `from` and `to`, renames detected; optional like `diffStat`. */
  changedFiles?(dir: string, range: CommitRange): Promise<ChangedFile[]>
}

/**
 * Conventional commit type after normalizing synonyms (`feature` → `feat`, `bugfix` → `fix`).
 * Unknown types are kept as written, lowercased.
 */
export type CommitType = string

/** What a commit message says, as far as conventions allow telling. */
export interface ParsedCommit {
  /** `undefined` when the subject is not a conventional commit. */
  type?: CommitType
  scope?: string
  breaking: boolean
  /** Text of a `BREAKING CHANGE:` footer. */
  breakingNote?: string
  /** Human-readable summary without the conventional prefix and reference noise. */
  description: string
  /** Issue tracker ids: `GTW-435` style keys and `#123` issue references, in order of appearance. */
  tickets: string[]
  /** Merge or pull request numbers: `(#123)`, `!123`, `See merge request group/x!12`. */
  mergeRequests: number[]
  merge: boolean
  /** Set for reverts; `sha` comes from git's `This reverts commit ...` line. */
  revert?: { subject?: string; sha?: string }
  coAuthors: Person[]
  /** `WIP`, `fixup!`, `squash!` and `amend!` commits. */
  wip: boolean
}

/** A commit together with its interpretation. */
export interface ChangelogCommit extends CommitInfo {
  parsed: ParsedCommit
}

/**
 * URL templates with `{placeholders}`, stored with the data so reports can be rendered later
 * without code: `{sha}`, `{from}`/`{to}`, `{n}`, `{name}`, `{id}`.
 */
export interface LinkTemplates {
  commit: string
  compare: string
  mergeRequest: string
  tag: string
  issue: string
  /** For tracker keys such as `GTW-435`, e.g. `https://jira.example.com/browse/{id}`. */
  ticket?: string
}

/** Serializable result of `analyzeChangelog`; the `changelog` analysis kind turns it into reports. */
export interface ChangelogData {
  /** Previous release; absent when `to` is the first one. */
  from?: ReleaseRef
  to: ReleaseRef
  /** Newest first. */
  commits: ChangelogCommit[]
  /** Net change between `from` and `to`, when the source can tell. */
  diff?: DiffStat
  /** Changed files, most changed lines first, at most `maxChangedFiles` of them. */
  files?: ChangedFile[]
  /** Set when `files` was cut at `maxChangedFiles`. */
  filesTruncated?: boolean
  /**
   * When `to` was released (ISO 8601): the tag's date for a tag or a commit carrying tags; absent
   * for unreleased refs such as `HEAD` or a branch.
   */
  releasedAt?: string
  /** Packages a monorepo release published, by name; absent for plain releases. */
  packages?: PackageRelease[]
  links?: LinkTemplates
}

/** Tools whose files a finding can come from. */
export type SourceTool =
  | 'npm'
  | 'bun'
  | 'pnpm'
  | 'yarn'
  | 'go'
  | 'maven'
  | 'gradle'
  | 'pip'
  | 'poetry'
  | 'uv'
  | 'pipenv'
  | 'cargo'
  | 'composer'
  | 'bundler'
  | 'nuget'
  | 'other'

export interface SourceInfo {
  tool: SourceTool
  /** Human name, e.g. `pnpm`, `Go modules`. */
  label: string
  /** Language family for grouping reports: `JavaScript`, `Go`, `Python`, ... */
  language: string
}

const byFile: Record<string, SourceInfo> = {
  'package-lock.json': { tool: 'npm', label: 'npm', language: 'JavaScript' },
  'npm-shrinkwrap.json': { tool: 'npm', label: 'npm', language: 'JavaScript' },
  'bun.lock': { tool: 'bun', label: 'Bun', language: 'JavaScript' },
  'bun.lockb': { tool: 'bun', label: 'Bun', language: 'JavaScript' },
  'pnpm-lock.yaml': { tool: 'pnpm', label: 'pnpm', language: 'JavaScript' },
  'yarn.lock': { tool: 'yarn', label: 'Yarn', language: 'JavaScript' },
  'go.mod': { tool: 'go', label: 'Go modules', language: 'Go' },
  'pom.xml': { tool: 'maven', label: 'Maven', language: 'Java' },
  'gradle.lockfile': { tool: 'gradle', label: 'Gradle', language: 'Java' },
  'buildscript-gradle.lockfile': { tool: 'gradle', label: 'Gradle', language: 'Java' },
  'requirements.txt': { tool: 'pip', label: 'pip', language: 'Python' },
  'poetry.lock': { tool: 'poetry', label: 'Poetry', language: 'Python' },
  'uv.lock': { tool: 'uv', label: 'uv', language: 'Python' },
  'Pipfile.lock': { tool: 'pipenv', label: 'Pipenv', language: 'Python' },
  'Cargo.lock': { tool: 'cargo', label: 'Cargo', language: 'Rust' },
  'composer.lock': { tool: 'composer', label: 'Composer', language: 'PHP' },
  'Gemfile.lock': { tool: 'bundler', label: 'Bundler', language: 'Ruby' },
  'packages.lock.json': { tool: 'nuget', label: 'NuGet', language: 'C#' },
}

/** Which package manager and language a finding's source file belongs to. Works in browsers too. */
export function sourceInfo(source: string): SourceInfo {
  const file = source.split('/').at(-1) ?? source
  return byFile[file] ?? { tool: 'other', label: file, language: 'Other' }
}

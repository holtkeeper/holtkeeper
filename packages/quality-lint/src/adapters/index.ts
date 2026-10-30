import type { LinterAdapter } from '../types.ts'
import { astGrepAdapter } from './ast-grep.ts'
import { biomeAdapter } from './biome.ts'
import { eslintAdapter } from './eslint.ts'
import { golangciLintAdapter } from './golangci-lint.ts'
import { oxlintAdapter } from './oxlint.ts'
import { ruffAdapter } from './ruff.ts'
import { semgrepAdapter } from './semgrep.ts'

export {
  astGrepAdapter,
  biomeAdapter,
  eslintAdapter,
  golangciLintAdapter,
  oxlintAdapter,
  ruffAdapter,
  semgrepAdapter,
}
export type { EslintAdapterOptions } from './eslint.ts'
export type { SemgrepAdapterOptions } from './semgrep.ts'

/** Every built-in adapter with default options, in the order `lintCheck` runs them. */
export const defaultAdapters = (): LinterAdapter[] => [
  oxlintAdapter(),
  eslintAdapter(),
  biomeAdapter(),
  golangciLintAdapter(),
  ruffAdapter(),
  semgrepAdapter(),
  astGrepAdapter(),
]

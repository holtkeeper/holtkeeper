import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { hasAny, projectBinary } from '../detect.ts'
import { parseEslintJson } from '../eslint-json.ts'
import { parseSarif } from '../sarif.ts'
import type { LinterAdapter } from '../types.ts'

const configs = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
]

const sarifFormatter = '@microsoft/eslint-formatter-sarif'

export interface EslintAdapterOptions {
  /**
   * `sarif` uses `@microsoft/eslint-formatter-sarif`, `json` uses `json-with-metadata` (keeps
   * autofixes and suggestions). `auto` (default) picks SARIF when the project has the formatter.
   */
  format?: 'auto' | 'sarif' | 'json'
}

/** ESLint, detected by a flat or legacy config file or an `eslintConfig` field in `package.json`. */
export const eslintAdapter = ({ format = 'auto' }: EslintAdapterOptions = {}): LinterAdapter => ({
  name: 'eslint',
  async detect(dir) {
    if (await hasAny(dir, configs)) return true
    const manifest: unknown = await Bun.file(join(dir, 'package.json'))
      .json()
      .catch(() => undefined)
    return typeof manifest === 'object' && manifest !== null && 'eslintConfig' in manifest
  },
  command(dir) {
    const sarif =
      format === 'sarif' ||
      (format === 'auto' && existsSync(join(dir, 'node_modules', sarifFormatter)))
    return [
      projectBinary(dir, 'eslint'),
      '--format',
      sarif ? sarifFormatter : 'json-with-metadata',
      '.',
    ]
  },
  parse(stdout, dir) {
    const report: unknown = JSON.parse(stdout)
    return typeof report === 'object' && report !== null && 'runs' in report
      ? parseSarif(stdout, { dir, tool: 'eslint' })
      : parseEslintJson(report, { dir })
  },
})

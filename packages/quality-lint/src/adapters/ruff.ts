import { fileContains, hasAny, projectBinary } from '../detect.ts'
import { parseSarif } from '../sarif.ts'
import type { LinterAdapter } from '../types.ts'

/**
 * Ruff through `ruff check --output-format sarif`. Detected by `ruff.toml`, `.ruff.toml` or a
 * `[tool.ruff]` section in `pyproject.toml`; a `.venv` copy of ruff is preferred.
 */
export const ruffAdapter = (): LinterAdapter => ({
  name: 'ruff',
  async detect(dir) {
    return (
      (await hasAny(dir, ['ruff.toml', '.ruff.toml'])) ||
      fileContains(dir, 'pyproject.toml', '[tool.ruff')
    )
  },
  command: (dir) => [
    projectBinary(dir, 'ruff', ['.venv/bin']),
    'check',
    '--output-format',
    'sarif',
    '--no-cache',
  ],
  parse: (stdout, dir) => parseSarif(stdout, { dir, tool: 'ruff' }),
})

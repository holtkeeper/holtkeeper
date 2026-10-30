import { hasAny } from '../detect.ts'
import { parseSarif } from '../sarif.ts'
import type { LinterAdapter } from '../types.ts'

const configs = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json']

/**
 * golangci-lint v2 through `run --output.sarif.path=stdout`; naming an output replaces the
 * default text output, so stdout carries only SARIF. Detected by a `.golangci.*` config.
 */
export const golangciLintAdapter = (): LinterAdapter => ({
  name: 'golangci-lint',
  detect: (dir) => hasAny(dir, configs),
  command: () => ['golangci-lint', 'run', '--output.sarif.path=stdout', '--show-stats=false'],
  parse: (stdout, dir) => parseSarif(stdout, { dir, tool: 'golangci-lint' }),
})

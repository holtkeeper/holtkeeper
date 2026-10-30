import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { hasAny } from '../detect.ts'
import { parseSarif } from '../sarif.ts'
import type { LinterAdapter } from '../types.ts'

const configs = ['.semgrep.yml', '.semgrep.yaml', '.semgrep']

export interface SemgrepAdapterOptions {
  /**
   * Also run on projects without their own rules, with `--config auto` (registry rules picked
   * for the project; needs network and sends metrics to Semgrep). Off by default.
   */
  auto?: boolean
}

/**
 * Semgrep CLI (LGPL, used as an external binary) through `semgrep scan --sarif`, with the
 * project's `.semgrep.yml`, `.semgrep.yaml` or `.semgrep/` rules. Fixes from rules with `fix:`
 * come through as `review` changes.
 */
export const semgrepAdapter = ({ auto = false }: SemgrepAdapterOptions = {}): LinterAdapter => ({
  name: 'semgrep',
  async detect(dir) {
    return auto || hasAny(dir, configs)
  },
  command(dir) {
    const config = configs.find((name) => existsSync(join(dir, name)))
    return [
      'semgrep',
      'scan',
      '--sarif',
      '--quiet',
      ...(config ? ['--config', config, '--metrics=off'] : ['--config', 'auto']),
    ]
  },
  parse: (stdout, dir) => parseSarif(stdout, { dir, tool: 'semgrep' }),
})

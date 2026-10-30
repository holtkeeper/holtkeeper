import { realpath } from 'node:fs/promises'

import { type CommandRunner, localRunner, runChecked } from '@holtkeeper/exec'
import type { Scanner } from '@holtkeeper/vuln'

import { parseScanOutput } from './parse.ts'

export interface OsvScannerOptions {
  runner?: CommandRunner
  /** Path or name of the osv-scanner binary. */
  binary?: string
  /** Extra arguments for `osv-scanner scan source`, e.g. `['--x-exclude', 'g:**\/examples\/**']`. */
  args?: string[]
}

/** osv-scanner's exit code when vulnerabilities were found; 0 means none. */
const VULNERABILITIES_FOUND = 1

/**
 * A `Scanner` backed by `osv-scanner scan source`. It reads lockfiles and manifests of every
 * ecosystem osv-scanner supports, without installing dependencies, and respects `.gitignore`.
 */
export function osvScanner({
  runner = localRunner,
  binary = 'osv-scanner',
  args = [],
}: OsvScannerOptions = {}): Scanner {
  return {
    name: 'osv-scanner',
    async scan(dir, { signal } = {}) {
      // osv-scanner reports resolved paths; resolve too so sources come out relative to `dir`.
      const root = await realpath(dir)
      const { stdout } = await runChecked(
        runner,
        [
          binary,
          'scan',
          'source',
          '--recursive',
          '--allow-no-lockfiles',
          '--format',
          'json',
          ...args,
          root,
        ],
        { cwd: root, signal },
        [0, VULNERABILITIES_FOUND],
      )
      const output: unknown = stdout.trim() ? JSON.parse(stdout) : {}
      return parseScanOutput(output, root)
    },
  }
}

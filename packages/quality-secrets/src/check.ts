import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'
import type { QualityCheck, QualityIssue } from '@holtkeeper/quality'

import { parseGitleaksReport } from './parse.ts'

export interface SecretsCheckOptions {
  /** Also scan every commit reachable in the checkout (`gitleaks git`). Default `false`. */
  history?: boolean
  /** gitleaks config, relative to the analyzed directory; default: its `.gitleaks.toml`, else gitleaks' rules. */
  config?: string
  /** Path or name of the gitleaks binary. */
  binary?: string
  /** Kills one gitleaks run after this long. */
  timeoutMs?: number
}

/** Passed as `--exit-code`: gitleaks also exits 1 on fatal errors, so leaks need their own code. */
const LEAKS_FOUND = 2

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function versionOf(runner: CommandRunner, binary: string, dir: string, signal?: AbortSignal) {
  try {
    const result = await runner.run([binary, 'version'], {
      cwd: dir,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    })
    return /\d+\.\d+\.\d+\S*/.exec(result.stdout)?.[0]
  } catch {
    return undefined
  }
}

const locationKey = (issue: QualityIssue) =>
  `${issue.rule}\0${issue.file}\0${issue.range?.start.line}`

/**
 * The `secrets` check: gitleaks over the working tree (`gitleaks dir`, which also sees untracked
 * files) and, with `history`, over every commit (`gitleaks git`). gitleaks runs with `--redact`
 * and its report goes to stdout, so the secret never leaves the process in clear text and never
 * reaches an issue. A repository `.gitleaks.toml` and `.gitleaksignore` apply as gitleaks reads
 * them from the scanned directory. History findings at the same rule, file and line as a working
 * tree finding are dropped as duplicates.
 */
export function secretsCheck({
  history = false,
  config,
  binary = 'gitleaks',
  timeoutMs,
}: SecretsCheckOptions = {}): QualityCheck {
  return {
    name: 'secrets',

    async detect() {
      return Boolean(isAbsolute(binary) ? await exists(binary) : Bun.which(binary))
    },

    async run({ dir, runner, signal }) {
      const options = {
        cwd: dir,
        ...(signal ? { signal } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      }
      const scan = async (mode: 'dir' | 'git') => {
        const { stdout } = await runChecked(
          runner,
          [
            binary,
            mode,
            '--no-banner',
            '--no-color',
            '--redact',
            '--log-level',
            'error',
            '--exit-code',
            String(LEAKS_FOUND),
            '--report-format',
            'json',
            '--report-path',
            '-',
            ...(config ? ['--config', config] : []),
            '.',
          ],
          options,
          [0, LEAKS_FOUND],
        )
        return parseGitleaksReport(stdout.trim() ? JSON.parse(stdout) : [], { dir })
      }

      const version = await versionOf(runner, binary, dir, signal)
      const issues = await scan('dir')
      if (history && (await exists(join(dir, '.git')))) {
        const seen = new Set(issues.map(locationKey))
        const ids = new Set(issues.map((issue) => issue.id))
        for (const issue of await scan('git'))
          if (!seen.has(locationKey(issue)) && !ids.has(issue.id)) {
            ids.add(issue.id)
            issues.push(issue)
          }
      }
      return { issues, ...(version ? { version: `gitleaks ${version}` } : {}) }
    },
  }
}

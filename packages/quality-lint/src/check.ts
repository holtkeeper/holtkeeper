import type { CommandRunner } from '@holtkeeper/exec'
import type { QualityCheck } from '@holtkeeper/quality'

import { defaultAdapters } from './adapters/index.ts'
import type { LinterAdapter, LintFindings } from './types.ts'

export interface LintCheckOptions {
  /** Linters to consider; defaults to `defaultAdapters()`. */
  adapters?: readonly LinterAdapter[]
  /** Restricts the run to these adapter names. */
  only?: readonly string[]
  /** Kills one linter run after this long. */
  timeoutMs?: number
}

/** Version string of a tool, `name 1.2.3`, from its `--version` output; `undefined` when it is not installed. */
async function probeVersion(
  runner: CommandRunner,
  adapter: LinterAdapter,
  dir: string,
  signal?: AbortSignal,
) {
  const command = adapter.versionCommand?.(dir) ?? [
    adapter.command(dir)[0] ?? adapter.name,
    '--version',
  ]
  try {
    const result = await runner.run(command, {
      cwd: dir,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    })
    if (result.exitCode !== 0) return undefined
    const version = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(result.stdout || result.stderr)?.[0]
    return `${adapter.name} ${version ?? 'unknown'}`
  } catch {
    return undefined
  }
}

/**
 * Runs every linter the project configures and has installed, one after another, and merges
 * their findings. Its `version` lists each tool that ran (`oxlint 1.90.0, ruff 0.9.1`). A linter
 * that fails is noted there and skipped; the check throws only when every linter that ran failed.
 */
export function lintCheck({
  adapters = defaultAdapters(),
  only,
  timeoutMs,
}: LintCheckOptions = {}): QualityCheck {
  const selected = only ? adapters.filter((adapter) => only.includes(adapter.name)) : [...adapters]
  const detected = async (dir: string) => {
    const flags = await Promise.all(
      selected.map((adapter) => adapter.detect(dir).catch(() => false)),
    )
    return selected.filter((_, index) => flags[index])
  }

  return {
    name: 'lint',
    async detect(dir) {
      return (await detected(dir)).length > 0
    },
    async run({ dir, runner, signal }) {
      const findings: LintFindings = { issues: [], changes: [] }
      const versions: string[] = []
      const failures: string[] = []

      for (const adapter of await detected(dir)) {
        signal?.throwIfAborted()
        // Linters run one at a time: each already uses every core.
        // oxlint-disable-next-line no-await-in-loop
        const version = await probeVersion(runner, adapter, dir, signal)
        if (!version) continue
        try {
          const command = adapter.command(dir)
          // oxlint-disable-next-line no-await-in-loop
          const result = await runner.run(command, {
            cwd: dir,
            ...(signal ? { signal } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          })
          if (!(adapter.okExitCodes ?? [0, 1]).includes(result.exitCode)) {
            const output = (result.stderr || result.stdout).trim().split('\n').slice(-5).join(' ')
            throw new Error(`exited with ${result.exitCode}${output ? `: ${output}` : ''}`)
          }
          // oxlint-disable-next-line no-await-in-loop
          const parsed = await adapter.parse(result.stdout, dir)
          findings.issues.push(...parsed.issues)
          findings.changes.push(...parsed.changes)
          versions.push(version)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          failures.push(`${adapter.name}: ${reason}`)
          versions.push(`${version} (failed: ${reason.slice(0, 200)})`)
        }
      }

      if (failures.length > 0 && failures.length === versions.length)
        throw new Error(failures.join('\n'))
      return { ...findings, ...(versions.length > 0 ? { version: versions.join(', ') } : {}) }
    },
  }
}

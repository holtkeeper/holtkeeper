import { basename, dirname, join } from 'node:path'

import { CommandError, localRunner, runChecked } from '@holtkeeper/exec'
import type { CommandRunner, RunOptions } from '@holtkeeper/exec'
import { trackChanges } from '@holtkeeper/vuln'
import type { Fixer } from '@holtkeeper/vuln'

import { planGoUpgrades } from './plan.ts'
import type { GoUpgrade } from './plan.ts'

export interface GoFixerOptions {
  /** Runs `go`; defaults to local child processes. */
  runner?: CommandRunner
}

/**
 * Environment for every `go` command. `GOTOOLCHAIN=local` makes a dependency that needs a newer Go
 * fail instead of downloading a toolchain; `GOWORK=off` keeps a parent `go.work` out of the way;
 * `GOFLAGS=-mod=mod` lets commands update `go.mod` even when a `vendor/` directory exists.
 */
export const goEnv: Readonly<Record<string, string>> = {
  GOTOOLCHAIN: 'local',
  GOWORK: 'off',
  GOFLAGS: '-mod=mod',
}

/** Results of applying upgrades in a module directory. */
interface GoUpgradeOutcome {
  /** Upgrades `go get` accepted. */
  applied: GoUpgrade[]
  notes: string[]
}

/**
 * Runs `go get <module>@<version>` for each upgrade in `moduleDir`, then `go mod tidy` if anything
 * was applied. A failed `go get` becomes a note; a failed `go mod tidy` throws `CommandError`.
 */
async function applyGoUpgrades(
  runner: CommandRunner,
  moduleDir: string,
  upgrades: readonly GoUpgrade[],
  signal?: AbortSignal,
): Promise<GoUpgradeOutcome> {
  const options: RunOptions = { cwd: moduleDir, env: goEnv, signal }
  const applied: GoUpgrade[] = []
  const notes: string[] = []

  for (const upgrade of upgrades) {
    const target = `${upgrade.module}@${upgrade.version}`
    try {
      // oxlint-disable-next-line no-await-in-loop -- each `go get` rewrites the same go.mod
      await runChecked(runner, ['go', 'get', target], options)
      applied.push(upgrade)
    } catch (error) {
      if (!(error instanceof CommandError)) throw error
      notes.push(error.message)
    }
  }

  if (applied.length > 0) await runChecked(runner, ['go', 'mod', 'tidy'], options)
  return { applied, notes }
}

/** Fixes Go module findings in `go.mod` files by upgrading the affected modules with `go get`. */
export function goFixer(options: GoFixerOptions = {}): Fixer {
  const runner = options.runner ?? localRunner

  return {
    name: 'go',
    supports: (source) => basename(source) === 'go.mod',
    async fix({ dir, source, findings, signal }) {
      const plan = planGoUpgrades(findings)
      if (plan.upgrades.length === 0) return { changedFiles: [], fixed: [], notes: plan.notes }

      const moduleDir = dirname(source)
      const files = [join(moduleDir, 'go.mod'), join(moduleDir, 'go.sum')]
      let outcome: GoUpgradeOutcome = { applied: [], notes: [] }
      const changedFiles = await trackChanges(dir, files, async () => {
        outcome = await applyGoUpgrades(runner, join(dir, moduleDir), plan.upgrades, signal)
      })

      return {
        changedFiles,
        fixed: outcome.applied.flatMap((upgrade) => upgrade.findingIds),
        notes: [...plan.notes, ...outcome.notes],
      }
    },
  }
}

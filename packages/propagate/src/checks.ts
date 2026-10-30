// oxlint-disable no-await-in-loop -- checks run one after another in the same checkout
import type { CommandRunner } from '@holtkeeper/exec'
import type { PackageManager } from '@holtkeeper/vuln-js'

import { detectNodeProject, installCommand, managerEnv } from './bump.ts'
import type { CheckResult, CheckSpec, Verifier } from './types.ts'

/** Check commands from options; a string replaces the detected command, `false` disables it. */
export interface CheckOptions {
  install?: string | false
  typecheck?: string | false
  lint?: string | false
  test?: string | false
  build?: string | false
  /** Go modules; default `go build ./... && go test ./...`. */
  go?: string | false
}

const scriptCandidates: [keyof CheckOptions, string[]][] = [
  ['typecheck', ['typecheck', 'type-check', 'tsc']],
  ['lint', ['lint']],
  ['test', ['test']],
  ['build', ['build']],
]

const runScript = (manager: PackageManager, script: string) =>
  `${manager.startsWith('yarn') ? 'yarn' : manager} run ${script}`

const quote = (part: string) =>
  /^[\w./@=:-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`

/**
 * Checks for the checkout at `dir`, in order: `install` (only when another JavaScript check
 * needs `node_modules`), `typecheck`, `lint`, `test`, `build` from `package.json` scripts, then
 * `go` when the repository has Go targets. Options override or disable each.
 */
export async function detectChecks(
  dir: string,
  options: { checks?: CheckOptions; go?: boolean; allowInstallScripts?: boolean } = {},
): Promise<CheckSpec[]> {
  const configured = options.checks ?? {}
  const project = await detectNodeProject(dir)
  const checks: CheckSpec[] = []
  if (project) {
    for (const [name, scripts] of scriptCandidates) {
      const given = configured[name]
      if (given === false) continue
      const script = scripts.find((candidate) => project.scripts[candidate] !== undefined)
      const command = given ?? (script ? runScript(project.manager, script) : undefined)
      if (command) checks.push({ name, command })
    }
    const install = configured.install
    if (install !== false && checks.length > 0)
      checks.unshift({
        name: 'install',
        command:
          install ??
          installCommand(project.manager, options.allowInstallScripts ?? false)
            .map(quote)
            .join(' '),
        env: managerEnv(options.allowInstallScripts ?? false),
      })
  }
  if (options.go && configured.go !== false)
    checks.push({
      name: 'go',
      command: configured.go ?? 'go build ./... && go test ./...',
      env: { GOTOOLCHAIN: 'local' },
    })
  return checks
}

/** The last `lines` lines of `text`, trimmed. */
export function tail(text: string, lines = 200): string {
  const all = text.trim().split('\n')
  const kept = all.slice(-lines).join('\n')
  return kept.length > 20_000 ? kept.slice(-20_000) : kept
}

/**
 * Runs each check as `sh -c <command>` in the checkout, in order, with `CI=1`. After a failing
 * `install` the remaining checks are not run. Never rejects for failing checks.
 */
export function createCommandVerifier(options: { timeoutMs?: number } = {}): Verifier {
  return {
    async verify({ dir, checks, runner, attempt, signal }) {
      const results: CheckResult[] = []
      for (const check of checks) {
        const started = performance.now()
        let exitCode: number
        let output: string
        try {
          const result = await runner.run(['sh', '-c', check.command], {
            cwd: dir,
            env: { CI: '1', FORCE_COLOR: '0', ...check.env },
            ...(signal ? { signal } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          })
          exitCode = result.exitCode
          output = [result.stdout, result.stderr].filter((part) => part.trim()).join('\n')
        } catch (error) {
          exitCode = -1
          output = error instanceof Error ? error.message : String(error)
        }
        results.push({
          name: check.name,
          command: check.command,
          exitCode,
          ok: exitCode === 0,
          output: tail(output),
          durationMs: Math.round(performance.now() - started),
          attempt,
        })
        if (check.name === 'install' && exitCode !== 0) break
      }
      return results
    },
  }
}

/** Verifier with a 20-minute timeout per check. */
export const defaultVerifier = createCommandVerifier({ timeoutMs: 20 * 60_000 })

/** Detects the checks of `dir` and runs them once; `specs` are what a fix loop re-runs. */
export async function verifyCheckout(input: {
  dir: string
  runner: CommandRunner
  checks?: CheckOptions
  go?: boolean
  allowInstallScripts?: boolean
  verifier?: Verifier
  signal?: AbortSignal
}): Promise<{ specs: CheckSpec[]; results: CheckResult[] }> {
  const specs = await detectChecks(input.dir, {
    ...(input.checks ? { checks: input.checks } : {}),
    ...(input.go ? { go: true } : {}),
    ...(input.allowInstallScripts ? { allowInstallScripts: true } : {}),
  })
  const results = await (input.verifier ?? defaultVerifier).verify({
    dir: input.dir,
    checks: specs,
    runner: input.runner,
    attempt: 0,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return { specs, results }
}

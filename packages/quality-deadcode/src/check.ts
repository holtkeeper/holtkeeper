import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { diskFiles } from '@holtkeeper/changes'
import type { CommandRunner } from '@holtkeeper/exec'
import type { QualityCheck } from '@holtkeeper/quality'

import { knipFindings } from './findings.ts'
import { parseKnipReport } from './report.ts'

export interface DeadCodeCheckOptions {
  /** knip `--production`: only production entry files, no tests or devDependencies. */
  production?: boolean
  /** knip `--include`: report only these issue types, e.g. `['files', 'dependencies']`. */
  include?: readonly string[]
  /** The knip command; defaults to `knipCommand(dir)`. */
  command?: (dir: string) => string[]
  timeoutMs?: number
}

const bundledKnip = join(import.meta.dir, '..', 'node_modules', 'knip', 'bin', 'knip.js')

/**
 * The project's own `node_modules/.bin/knip` when it has one (projects pin their knip and its
 * plugins), else the knip 6 this package depends on, run by the current runtime.
 */
export function knipCommand(dir: string): string[] {
  const local = join(dir, 'node_modules', '.bin', 'knip')
  return existsSync(local) ? [local] : [process.execPath, bundledKnip]
}

/** knip's arguments for a JSON report on stdout that never fails on findings. */
export function knipArgs({ production, include }: DeadCodeCheckOptions = {}): string[] {
  return [
    '--reporter',
    'json',
    '--no-exit-code',
    '--no-progress',
    ...(production ? ['--production'] : []),
    ...(include?.length ? ['--include', include.join(',')] : []),
  ]
}

async function knipVersion(
  runner: CommandRunner,
  command: string[],
  dir: string,
  signal?: AbortSignal,
) {
  try {
    const result = await runner.run([...command, '--version'], {
      cwd: dir,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    })
    return /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(result.stdout)?.[0]
  } catch {
    return undefined
  }
}

async function declaresDependencies(dir: string): Promise<boolean> {
  try {
    const manifest: unknown = await Bun.file(join(dir, 'package.json')).json()
    if (typeof manifest !== 'object' || manifest === null) return false
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some((field) => {
      const deps: unknown = Reflect.get(manifest, field)
      return typeof deps === 'object' && deps !== null && Object.keys(deps).length > 0
    })
  } catch {
    return false
  }
}

/**
 * Dead code and dependency hygiene with knip, check name `deadcode`. Applies to projects with a
 * `package.json`. knip runs in the project directory with the project's knip configuration (its
 * defaults when there is none). Contributes `lint` issues with `deadcode/*` rules and `review`
 * changes; throws when knip exits non-zero (a configuration error) or prints no JSON report.
 * `skipped` when the project declares dependencies but has no `node_modules`: without them knip
 * cannot load plugin configs or see which binaries and packages they provide.
 */
export function deadCodeCheck(options: DeadCodeCheckOptions = {}): QualityCheck {
  return {
    name: 'deadcode',
    detect: async (dir) => Bun.file(join(dir, 'package.json')).exists(),
    async run({ dir, runner, signal }) {
      if (!existsSync(join(dir, 'node_modules')) && (await declaresDependencies(dir)))
        return { issues: [], changes: [], skipped: 'dependencies are not installed' }
      const command = options.command?.(dir) ?? knipCommand(dir)
      const version = await knipVersion(runner, command, dir, signal)
      const result = await runner.run([...command, ...knipArgs(options)], {
        cwd: dir,
        ...(signal ? { signal } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      })
      if (result.exitCode !== 0) {
        const output = (result.stderr || result.stdout).trim().split('\n').slice(-5).join(' ')
        throw new Error(`knip exited with ${result.exitCode}${output ? `: ${output}` : ''}`)
      }
      const findings = await knipFindings(parseKnipReport(result.stdout), diskFiles(dir))
      return { ...findings, ...(version ? { version: `knip ${version}` } : {}) }
    },
  }
}

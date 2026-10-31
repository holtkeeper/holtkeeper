import { isAbsolute, join, normalize } from 'node:path'

import { defineAnalyzer, jsLockfiles, lockfileHasPackage } from '@holtkeeper/analyzer'
import type { CommandRunner } from '@holtkeeper/exec'
import { changedFiles, describeMergeRequest, publishChanges } from '@holtkeeper/propagate'
import { type PackageManager, detectPackageManager, lockfileKind } from '@holtkeeper/vuln-js'
import { z } from 'zod'

import { type BrowserTargets, type BrowserslistData, targetChanges } from './model.ts'
import { browserslistAnalysis } from './report.ts'

const insideCheckout = z
  .string()
  .refine(
    (value) => !isAbsolute(value) && !normalize(value).startsWith('..'),
    'expected a path inside the checkout',
  )

/** Options of the `browserslist` analyzer. */
export const browserslistOptionsSchema = z.object({
  /** Shell command that updates the database; default: `update-browserslist-db@latest` through the repository's package manager. */
  command: z.string().trim().min(1).optional(),
  /** Directories whose resolved browsers the report compares; empty skips the install this needs. */
  dirs: z.array(insideCheckout).default(['.']),
  /** Run dependency lifecycle scripts during installs. */
  allowInstallScripts: z.coerce.boolean().default(false),
  /** Per command. */
  timeoutMinutes: z.coerce.number().positive().default(15),
  branch: z.string().min(1).default('holtkeeper/browserslist'),
  labels: z.array(z.string()).default(['holtkeeper', 'dependencies']),
  /**
   * Have the forge merge the merge request once its checks pass: right away when nothing blocks
   * it, otherwise after the pipeline and the approvals it needs.
   */
  autoMerge: z.coerce.boolean().default(false),
  /** Update and report, but open no merge request. */
  dryRun: z.coerce.boolean().default(false),
})

export type BrowserslistOptions = z.output<typeof browserslistOptionsSchema>

const updateCommands: Record<PackageManager, string[]> = {
  npm: ['npx', '--yes', 'update-browserslist-db@latest'],
  'yarn-classic': ['npx', '--yes', 'update-browserslist-db@latest'],
  'yarn-berry': ['yarn', 'dlx', 'update-browserslist-db@latest'],
  pnpm: ['pnpm', 'dlx', 'update-browserslist-db@latest'],
  bun: ['bunx', 'update-browserslist-db@latest'],
}

const installCommands: Record<PackageManager, string[]> = {
  npm: ['npm', 'ci', '--no-audit', '--no-fund'],
  'yarn-classic': ['yarn', 'install', '--frozen-lockfile'],
  'yarn-berry': ['yarn', 'install', '--immutable'],
  pnpm: ['pnpm', 'install', '--frozen-lockfile'],
  bun: ['bun', 'install', '--frozen-lockfile'],
}

const noScripts: Partial<Record<PackageManager, string>> = {
  npm: '--ignore-scripts',
  'yarn-classic': '--ignore-scripts',
  pnpm: '--ignore-scripts',
  bun: '--ignore-scripts',
}

// pnpm keeps transitive packages out of the root `node_modules`, but hoists them all into `.pnpm/node_modules`.
const resolveBrowsers = `
const { createRequire } = require('module')
const { join } = require('path')
for (const from of [join(process.cwd(), 'package.json'), join(process.env.HOLTKEEPER_ROOT, 'node_modules/.pnpm/node_modules/x.js')]) {
  let browserslist
  try { browserslist = createRequire(from)('browserslist') } catch { continue }
  console.log(JSON.stringify(browserslist(undefined, { path: process.cwd() })))
  process.exit(0)
}
process.exit(3)
`

const resolverCommand = (manager: PackageManager) =>
  manager === 'bun'
    ? ['bun', '-e', resolveBrowsers]
    : manager === 'yarn-berry'
      ? ['yarn', 'node', '-e', resolveBrowsers]
      : ['node', '-e', resolveBrowsers]

/** `caniuse-lite` versions in lockfile text, sorted; its versions all look like `1.0.300NNNNN`. */
export function caniuseVersions(lockfile: string): string[] {
  return [...new Set(lockfile.match(/\b1\.0\.300\d{5}\b/g) ?? [])].toSorted()
}

const lastLines = (text: string, count: number) =>
  text.replace(/\s+$/, '').split('\n').slice(-count).join('\n')

const bulletList = (items: string[]) => items.map((item) => `- \`${item}\``).join('\n')

/** Merge request description: database versions and the browsers each directory gained or lost. */
export function browserslistDescription(data: BrowserslistData): string {
  const sections = [
    {
      title: 'caniuse-lite',
      body: `\`${data.before.join(', ') || 'none'}\` → \`${data.after.join(', ') || 'none'}\` in \`${data.lockfile ?? 'lockfile'}\``,
    },
  ]
  for (const targets of data.targets) {
    const where = targets.dir === '.' ? 'the repository root' : `\`${targets.dir}\``
    if (!targets.before || !targets.after) {
      sections.push({
        title: `Browsers in ${where}`,
        body: 'Could not resolve the browser list; check the targets by hand.',
      })
      continue
    }
    const { added, removed } = targetChanges(targets)
    sections.push({
      title: `Browsers in ${where}`,
      body:
        added.length + removed.length === 0
          ? 'The resolved browser list did not change.'
          : [
              ...(added.length ? ['Added:', bulletList(added)] : []),
              ...(removed.length ? ['Removed:', bulletList(removed)] : []),
            ].join('\n\n'),
    })
  }
  return describeMergeRequest({ sections, checks: [] })
}

/** Finds the root lockfile that resolves `caniuse-lite`. */
async function findLockfile(dir: string) {
  for (const name of jsLockfiles) {
    const file = Bun.file(join(dir, name))
    // oxlint-disable-next-line no-await-in-loop -- stops at the first lockfile, like package managers do
    if (!(await file.exists())) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    const text = await file.text()
    const kind = lockfileKind(name)
    if (kind && caniuseVersions(text).length) return { name, kind, text }
  }
  return undefined
}

/**
 * The `browserslist` analyzer (scope `repo`, needs `forge`): runs `update-browserslist-db` in a
 * writable checkout of the default branch through the repository's package manager and, when the
 * lockfile changed, opens or updates one merge request on `branch` that lists the `caniuse-lite`
 * versions and the browsers each of `dirs` gained or lost. Applies to repositories whose root
 * lockfile resolves `caniuse-lite`. `now` exists for tests.
 */
export function createBrowserslistAnalyzer(
  settings: { now?: () => Date; sleep?: (ms: number) => Promise<void> } = {},
) {
  const now = settings.now ?? (() => new Date())
  const sleep = settings.sleep ?? ((ms: number) => Bun.sleep(ms))
  return defineAnalyzer<BrowserslistData, BrowserslistOptions>({
    kind: 'browserslist',
    analysis: browserslistAnalysis,
    scope: 'repo',
    exclusive: true,
    needs: { forge: true },
    options: browserslistOptionsSchema,
    flags: [
      { flag: 'dry-run', option: 'dryRun', description: 'open no merge request', type: 'boolean' },
      {
        flag: 'command',
        option: 'command',
        description: 'shell command that updates the database',
      },
    ],
    appliesTo: lockfileHasPackage('caniuse-lite'),
    async run({ repo, forge, checkout, runner: hostRunner, options, signal, log }) {
      if (!forge || !checkout)
        throw new Error('the browserslist analyzer needs a forge and checkouts')
      const startedAt = now().toISOString()
      const tree = await checkout(repo, { writable: true })
      const runner: CommandRunner = tree.runner ?? hostRunner
      const timeoutMs = options.timeoutMinutes * 60_000
      const env = {
        CI: '1',
        HOLTKEEPER_ROOT: tree.dir,
        ...(!options.allowInstallScripts && {
          npm_config_ignore_scripts: 'true',
          YARN_ENABLE_SCRIPTS: 'false',
        }),
      }
      const exec = (command: string[], cwd = tree.dir) =>
        runner.run(command, { cwd, env, timeoutMs, ...(signal && { signal }) })

      const empty = {
        before: [],
        after: [],
        targets: [],
        files: [],
        dryRun: options.dryRun,
        output: '',
        startedAt,
      }
      const lockfile = await findLockfile(tree.dir)
      if (!lockfile) {
        log?.('browserslist: no root lockfile resolves caniuse-lite')
        return { data: { status: 'not-applicable', ...empty }, ref: tree.sha }
      }
      const packageJson = Bun.file(join(tree.dir, 'package.json'))
      const manifest: { packageManager?: unknown } = (await packageJson.exists())
        ? await packageJson.json()
        : {}
      const manager = await detectPackageManager(lockfile.kind, tree.dir, manifest.packageManager)
      const before = caniuseVersions(lockfile.text)

      const install = async () => {
        const flag = options.allowInstallScripts ? undefined : noScripts[manager]
        const result = await exec([...installCommands[manager], ...(flag ? [flag] : [])])
        if (result.exitCode !== 0) log?.(`browserslist: install exited with ${result.exitCode}`)
        return result.exitCode === 0
      }
      const browsers = async (dir: string) => {
        const result = await exec(resolverCommand(manager), join(tree.dir, dir))
        if (result.exitCode !== 0) return undefined
        try {
          const parsed = z.array(z.string()).safeParse(JSON.parse(result.stdout.trim()))
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      }

      const targets: BrowserTargets[] = options.dirs.map((dir) => ({ dir }))
      if (targets.length && (await install()))
        for (const target of targets) {
          // oxlint-disable-next-line no-await-in-loop -- commands share the checkout
          const resolved = await browsers(target.dir)
          if (resolved) target.before = resolved
        }

      const command = options.command ? ['sh', '-c', options.command] : updateCommands[manager]
      log?.(`browserslist: ${command.join(' ')} (${manager})`)
      const update = await exec(command)
      const output = lastLines([update.stdout, update.stderr].filter(Boolean).join('\n'), 80)
      const after = caniuseVersions(await Bun.file(join(tree.dir, lockfile.name)).text())
      const base = { lockfile: lockfile.name, packageManager: manager, before, after, targets }
      if (update.exitCode !== 0) {
        log?.(`browserslist: update exited with ${update.exitCode}`)
        return {
          data: { status: 'failed', ...empty, ...base, output },
          ref: tree.sha,
        }
      }

      const files = await changedFiles(tree.dir, hostRunner)
      if (!files.length) {
        log?.(`browserslist: caniuse-lite ${after.join(', ')} is current`)
        return { data: { status: 'up-to-date', ...empty, ...base, output }, ref: tree.sha }
      }

      if (targets.length && (await install()))
        for (const target of targets) {
          // oxlint-disable-next-line no-await-in-loop -- commands share the checkout
          const resolved = await browsers(target.dir)
          if (resolved) target.after = resolved
        }

      const data: BrowserslistData = {
        status: 'updated',
        ...empty,
        ...base,
        files: files.map((file) => file.path),
        output,
      }
      if (options.dryRun) {
        log?.(`browserslist: dry run, ${files.length} changed file(s) not published`)
        return { data, ref: tree.sha }
      }
      const mergeRequest = await publishChanges({
        forge,
        repo: repo.path,
        dir: tree.dir,
        files,
        branch: options.branch,
        title:
          `chore(deps): update browserslist database to caniuse-lite ${after.at(-1) ?? ''}`.trim(),
        description: browserslistDescription(data),
        labels: options.labels,
        ...(tree.publisher ? { mode: 'git' as const, git: tree.publisher } : {}),
      })
      if (mergeRequest) {
        data.mergeRequest = mergeRequest
        log?.(`browserslist: ${mergeRequest.url}`)
        if (options.autoMerge && !mergeRequest.draft) {
          const error = await setAutoMerge(
            () =>
              forge.mergeMergeRequest(repo.path, mergeRequest.id, {
                whenPipelineSucceeds: true,
                removeSourceBranch: true,
              }),
            sleep,
          )
          data.mergeRequest.autoMerge = error ? 'failed' : 'set'
          log?.(`browserslist: auto-merge ${error ? `not set: ${error}` : 'set'}`)
        }
      }
      return { data, ref: tree.sha }
    },
  })
}

// GitLab refuses to merge while it still computes a new merge request's mergeability.
async function setAutoMerge(
  merge: () => Promise<void>,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  let error = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- retries
    if (attempt) await sleep(10_000)
    try {
      // oxlint-disable-next-line no-await-in-loop -- retries
      await merge()
      return undefined
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
  return error
}

/** The `browserslist` analyzer with the real clock. */
export const browserslistAnalyzer = createBrowserslistAnalyzer()

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'

import {
  assertSigningKey,
  type CommitSigning,
  sshCloneUrl,
  type SshTransport,
  withSigningConfig,
  withSshEnv,
} from './ssh.ts'

/** HTTP credentials for cloning, e.g. a GitLab token as `{ username: 'oauth2', password }`. */
export interface GitCredentials {
  username: string
  password: string
}

export interface CheckoutOptions {
  cloneUrl: string
  /** Branch, tag or commit; the remote's default branch when omitted. */
  ref?: string
  /** Sent only to the git processes that talk to the remote; never written to disk. */
  credentials?: GitCredentials
  /**
   * Clone, fetch and push over SSH instead (`cloneUrl` is turned into `git@host:path.git`, see
   * `sshCloneUrl`). Takes precedence over `credentials`. The key lives in a private temp file
   * only while each remote git call runs, never in git config.
   */
  ssh?: SshTransport
  /** Signs commits made with `GitCheckout.commit`; also sets their author and committer. */
  signing?: CommitSigning
  /** Author and committer of `commit` when `signing` is not set. Default: git's own config. */
  author?: { name: string; email: string }
  /** Holds one bare mirror per repository; created when missing. */
  cacheDir: string
  runner: CommandRunner
  signal?: AbortSignal
  /** Parent of the per-checkout temporary directory. Default: the OS temp directory. */
  workDir?: string
  log?: (line: string) => void
}

/** A working tree at one commit, private to its caller until `cleanup`. */
export interface Checkout {
  dir: string
  /** Full commit sha that is checked out. */
  sha: string
  /** The requested ref, or the default branch name when none was requested. */
  ref: string
  /** Removes the working tree; safe to call more than once. */
  cleanup(): Promise<void>
}

/** A checkout that can also commit its changes and push them back to the remote. */
export interface GitCheckout extends Checkout {
  /**
   * Stages `paths` (every change when omitted, deletions included) and commits them on the
   * detached `HEAD`, signed when `signing` was given. `undefined` when nothing is staged.
   */
  commit(input: { message: string; paths?: string[] }): Promise<{ sha: string } | undefined>
  /**
   * Pushes `HEAD` to `branch` over the checkout's transport, replacing the branch only if it still
   * points where the last fetch saw it (`--force-with-lease`). Skips the push and reports
   * `pushed: false` when the branch already holds the same tree.
   */
  push(input: { branch: string }): Promise<{ pushed: boolean; sha: string }>
}

const usernameVariable = 'HOLTKEEPER_GIT_USERNAME'
const passwordVariable = 'HOLTKEEPER_GIT_PASSWORD'

// The helper reads the secret from the environment of the one git process, so it never shows up
// in argv, in the mirror's config or in the remote URL.
const credentialHelper = `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$${usernameVariable}" "$${passwordVariable}"; }; f`

const baseEnv = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: undefined, SSH_ASKPASS: undefined }

const remoteGit = (args: string[], credentials: GitCredentials | undefined) =>
  credentials
    ? {
        command: [
          'git',
          '-c',
          'credential.helper=',
          '-c',
          `credential.helper=${credentialHelper}`,
          ...args,
        ],
        env: {
          ...baseEnv,
          [usernameVariable]: credentials.username,
          [passwordVariable]: credentials.password,
        },
      }
    : { command: ['git', ...args], env: baseEnv }

/** Stable directory name for a repository's mirror; credentials in the URL do not change it. */
export function mirrorName(cloneUrl: string): string {
  const withoutAuth = cloneUrl.replace(/^([a-z+]+:\/\/)[^@/]*@/i, '$1')
  const hash = new Bun.CryptoHasher('sha256').update(withoutAuth).digest('hex').slice(0, 12)
  const tail =
    withoutAuth
      .replace(/\.git\/?$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .slice(-2)
      .join('-')
      .replace(/[^\w.-]/g, '_') || 'repo'
  return `${tail}-${hash}.git`
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

const locks = new Map<string, Promise<unknown>>()

/** Runs `task` after every earlier task for the same key has settled. */
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  const settled: Promise<unknown> = next
    .catch(() => undefined)
    .finally(() => {
      if (locks.get(key) === settled) locks.delete(key)
    })
  locks.set(key, settled)
  return next
}

/**
 * Checks out `ref` of a remote repository into a fresh temporary directory. A bare mirror per
 * repository in `cacheDir` is cloned once and fetched (`--prune --tags`) on every call, so the
 * checkout has full history, every branch and every tag while only new objects cross the network.
 * The checkout is a git worktree of the mirror; `cleanup` removes it.
 */
export async function checkout(options: CheckoutOptions): Promise<GitCheckout> {
  const { credentials, cacheDir, runner, signal, ssh } = options
  if (options.signing) assertSigningKey(options.signing)
  const cloneUrl = ssh ? sshCloneUrl(options.cloneUrl, ssh.user) : options.cloneUrl
  const log = options.log ?? (() => {})
  const mirror = join(cacheDir, mirrorName(cloneUrl))
  const git = (args: string[], cwd: string) =>
    runChecked(runner, ['git', ...args], { cwd, env: baseEnv, ...(signal ? { signal } : {}) })
  const remote = (args: string[], cwd: string) => {
    const run = (command: string[], env: Record<string, string | undefined>) =>
      runChecked(runner, command, { cwd, env, ...(signal ? { signal } : {}) })
    if (ssh)
      return withSshEnv(ssh, options.workDir, (env) =>
        run(['git', '-c', 'credential.helper=', ...args], { ...baseEnv, ...env }),
      )
    const call = remoteGit(args, credentials)
    return run(call.command, call.env)
  }

  const { sha, ref, dir, temp } = await serialized(mirror, async () => {
    await mkdir(cacheDir, { recursive: true })
    if (await exists(join(mirror, 'HEAD'))) {
      log(`fetching ${mirrorName(cloneUrl)}`)
      await remote(['fetch', '--prune', '--tags', 'origin'], mirror)
    } else {
      log(`cloning ${mirrorName(cloneUrl)}`)
      await rm(mirror, { recursive: true, force: true })
      try {
        await remote(['clone', '--mirror', '--quiet', cloneUrl, mirror], cacheDir)
      } catch (error) {
        await rm(mirror, { recursive: true, force: true })
        throw error
      }
    }

    const resolvedRef =
      options.ref ??
      (await git(['symbolic-ref', '--short', 'HEAD'], mirror)).stdout.trim().replace(/^heads\//, '')
    const commit = (
      await git(['rev-parse', '--verify', '--end-of-options', `${resolvedRef}^{commit}`], mirror)
    ).stdout.trim()

    await git(['worktree', 'prune'], mirror)
    const parent = await mkdtemp(join(options.workDir ?? tmpdir(), 'holtkeeper-checkout-'))
    const worktree = join(parent, 'repo')
    try {
      await git(['worktree', 'add', '--detach', '--quiet', worktree, commit], mirror)
    } catch (error) {
      await rm(parent, { recursive: true, force: true })
      throw error
    }
    log(`checked out ${resolvedRef} at ${commit.slice(0, 12)}`)
    return { sha: commit, ref: resolvedRef, dir: worktree, temp: parent }
  })

  const identity = options.signing ?? options.author
  // Environment variables beat both `user.*` config and inherited GIT_AUTHOR_* values.
  const identityEnv = identity
    ? {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      }
    : {}
  const rev = async (expression: string) => {
    const result = await runner.run(['git', 'rev-parse', '--verify', '--quiet', expression], {
      cwd: dir,
      env: baseEnv,
    })
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  }

  let cleaned: Promise<void> | undefined
  return {
    dir,
    sha,
    ref,
    async commit({ message, paths }) {
      await git(
        ['--literal-pathspecs', 'add', '--all', '--', ...(paths?.length ? paths : ['.'])],
        dir,
      )
      const staged = await runChecked(
        runner,
        ['git', 'diff', '--cached', '--quiet'],
        { cwd: dir, env: baseEnv },
        [0, 1],
      )
      if (staged.exitCode === 0) return undefined
      const run = (config: string[]) =>
        runChecked(
          runner,
          ['git', ...config, 'commit', '--quiet', '--no-verify', '--message', message],
          { cwd: dir, env: { ...baseEnv, ...identityEnv } },
        )
      await (options.signing ? withSigningConfig(options.signing, options.workDir, run) : run([]))
      const head = await rev('HEAD')
      if (!head) throw new Error('git commit did not move HEAD')
      return { sha: head }
    },
    async push({ branch }) {
      if (branch.startsWith('-')) throw new Error(`invalid branch name: ${branch}`)
      await git(['check-ref-format', `refs/heads/${branch}`], dir)
      const head = await rev('HEAD')
      if (!head) throw new Error('nothing to push')
      const remoteRef = `refs/heads/${branch}`
      const known = await rev(remoteRef)
      if (known && (await rev(`${known}^{tree}`)) === (await rev(`${head}^{tree}`)))
        return { pushed: false, sha: known }
      await remote(
        [
          'push',
          '--quiet',
          '--no-verify',
          `--force-with-lease=${remoteRef}:${known ?? ''}`,
          cloneUrl,
          `${head}:${remoteRef}`,
        ],
        dir,
      )
      await git(['update-ref', remoteRef, head], mirror)
      log(`pushed ${head.slice(0, 12)} to ${branch}`)
      return { pushed: true, sha: head }
    },
    cleanup() {
      cleaned ??= serialized(mirror, async () => {
        await runner
          .run(['git', 'worktree', 'remove', '--force', dir], { cwd: mirror, env: baseEnv })
          .catch(() => undefined)
        await rm(temp, { recursive: true, force: true })
        await runner
          .run(['git', 'worktree', 'prune'], { cwd: mirror, env: baseEnv })
          .catch(() => undefined)
      })
      return cleaned
    },
  }
}

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CommandRunner, localRunner, runChecked } from '@holtkeeper/exec'
import { generateKeyPair } from '@holtkeeper/ssh-keys'

import { checkout } from '../src/index.ts'

const isolated = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const git = (cwd: string, ...args: string[]) =>
  runChecked(localRunner, ['git', ...args], { cwd, env: isolated })

// Stands in for OpenSSH: checks the arguments and key files git passes, then runs the requested
// git-upload-pack / git-receive-pack against a local directory instead of a remote host.
const fakeSsh = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
key=""; known=""; strict=""; only=""
while [ $# -gt 0 ]; do
  case "$1" in
    -i) key="$2"; shift 2 ;;
    -o)
      case "$2" in
        UserKnownHostsFile=*) known="\${2#UserKnownHostsFile=}" ;;
        StrictHostKeyChecking=yes) strict=1 ;;
        IdentitiesOnly=yes) only=1 ;;
      esac
      shift 2 ;;
    -F|-p) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ "$1" = "git@example.test" ] || { echo "unexpected host $1" >&2; exit 2; }
[ -n "$strict" ] && [ -n "$only" ] || { echo "missing options" >&2; exit 3; }
mode=$(stat -c %a "$key" 2>/dev/null || stat -f %Lp "$key")
[ "$mode" = "600" ] || { echo "key mode $mode" >&2; exit 4; }
grep -q 'BEGIN OPENSSH PRIVATE KEY' "$key" || { echo "no key" >&2; exit 5; }
grep -q '^example.test ' "$known" || { echo "no pinned host" >&2; exit 6; }
eval "set -- $2"
exec "$1" "$FAKE_SSH_ROOT/$2"
`

const tools = ['git', 'ssh-keygen'].every((tool) => Bun.which(tool))

describe.skipIf(!tools)('checkout over SSH with real git', () => {
  let root: string
  let served: string
  let runner: CommandRunner
  const log = () => join(root, 'ssh.log')
  const signer = generateKeyPair({ type: 'ed25519', comment: 'bot@example.test' })
  const hostKey = generateKeyPair({ type: 'ed25519' })
  const ssh = {
    privateKey: generateKeyPair({ type: 'ed25519' }).privateKey,
    knownHosts: `example.test ${hostKey.publicKey}\n`,
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'holtkeeper-ws-ssh-'))
    const bin = join(root, 'bin')
    await mkdir(bin)
    await Bun.write(join(bin, 'ssh'), fakeSsh)
    await chmod(join(bin, 'ssh'), 0o755)
    const work = join(root, 'work')
    await Bun.write(join(work, 'a.txt'), 'one\n')
    await git(work, 'init', '-q', '-b', 'main')
    await git(work, 'add', '.')
    await git(work, 'commit', '-q', '-m', 'init')
    served = join(root, 'srv', 'games', 'a.git')
    await mkdir(join(root, 'srv', 'games'), { recursive: true })
    await git(root, 'clone', '-q', '--bare', work, served)
    const env = {
      ...isolated,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      FAKE_SSH_LOG: log(),
      FAKE_SSH_ROOT: join(root, 'srv'),
    }
    runner = {
      run: (command, options) =>
        localRunner.run(command, { ...options, env: { ...env, ...options.env } }),
    }
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('clones, commits signed, and pushes over the SSH command', async () => {
    const tree = await checkout({
      cloneUrl: 'https://example.test/games/a.git',
      ssh,
      signing: {
        privateKey: signer.privateKey,
        publicKey: signer.publicKey,
        name: 'Holtkeeper Bot',
        email: 'bot@example.test',
      },
      cacheDir: join(root, 'cache'),
      workDir: root,
      runner,
    })
    try {
      expect(tree.ref).toBe('main')
      const calls = (await Bun.file(log()).text()).trim().split('\n')
      expect(calls[0]).toContain('git@example.test')
      expect(calls[0]).toContain("git-upload-pack 'games/a.git'")

      expect(await tree.commit({ message: 'nothing' })).toBeUndefined()
      await Bun.write(join(tree.dir, 'a.txt'), 'two\n')
      await Bun.write(join(tree.dir, 'b.txt'), 'new\n')
      const commit = await tree.commit({ message: 'chore: update', paths: ['a.txt', 'b.txt'] })
      expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/)

      expect(await tree.push({ branch: 'holtkeeper/update' })).toEqual({
        pushed: true,
        sha: commit!.sha,
      })
      const pushedHead = (
        await git(served, 'rev-parse', 'refs/heads/holtkeeper/update')
      ).stdout.trim()
      expect(pushedHead).toBe(commit!.sha)
      expect((await Bun.file(log()).text()).includes('git-receive-pack')).toBeTrue()
      expect(await tree.push({ branch: 'holtkeeper/update' })).toEqual({
        pushed: false,
        sha: commit!.sha,
      })

      const raw = (await git(served, 'cat-file', 'commit', pushedHead)).stdout
      const lines = raw.split('\n')
      const start = lines.findIndex((line) => line.startsWith('gpgsig '))
      expect(start).toBeGreaterThan(0)
      let end = start + 1
      while (lines[end]?.startsWith(' ')) end++
      const signature = [
        lines[start]!.slice('gpgsig '.length),
        ...lines.slice(start + 1, end).map((l) => l.slice(1)),
      ].join('\n')
      const payload = [...lines.slice(0, start), ...lines.slice(end)].join('\n')
      expect(raw).toContain('author Holtkeeper Bot <bot@example.test>')

      const verify = join(root, 'verify')
      await mkdir(verify, { recursive: true })
      await Bun.write(join(verify, 'allowed'), `bot@example.test ${signer.publicKey}\n`)
      await Bun.write(join(verify, 'sig'), `${signature}\n`)
      await Bun.write(join(verify, 'payload'), payload)
      const process = Bun.spawn(
        [
          'ssh-keygen',
          '-Y',
          'verify',
          '-f',
          join(verify, 'allowed'),
          '-I',
          'bot@example.test',
          '-n',
          'git',
          '-s',
          join(verify, 'sig'),
        ],
        { stdin: Bun.file(join(verify, 'payload')), stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, code] = await Promise.all([
        new Response(process.stdout).text(),
        process.exited,
      ])
      expect(stdout).toContain('Good "git" signature for bot@example.test')
      expect(code).toBe(0)
    } finally {
      await tree.cleanup()
    }
    const leftovers = await Array.fromAsync(
      new Bun.Glob('holtkeeper-key-*').scan({ cwd: root, onlyFiles: false }),
    )
    expect(leftovers).toEqual([])
  })

  test('refuses to overwrite a branch that moved since the fetch', async () => {
    const tree = await checkout({
      cloneUrl: 'https://example.test/games/a.git',
      ssh,
      author: { name: 'Bot', email: 'bot@example.test' },
      cacheDir: join(root, 'cache'),
      workDir: root,
      runner,
    })
    try {
      await git(
        served,
        'update-ref',
        'refs/heads/holtkeeper/update',
        (await git(served, 'rev-parse', 'main')).stdout.trim(),
      )
      await Bun.write(join(tree.dir, 'c.txt'), 'c\n')
      await tree.commit({ message: 'chore: c' })
      const error = await tree.push({ branch: 'holtkeeper/update' }).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain('stale info')
    } finally {
      await tree.cleanup()
    }
  })
})

import { describe, expect, test } from 'bun:test'

import { localRunner } from '@holtkeeper/exec'
import { createFakeRunner } from '@holtkeeper/exec/testing'

import { containerPath, containerRunner, detectEngine, networksFor } from './container.ts'
import { localMiseRunner } from './local.ts'

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

const kept = (env: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([, value]) => value !== undefined))

const toolchain = {
  tools: [
    { name: 'node', version: '20', source: '.nvmrc' },
    { name: 'pnpm', version: '9.12.0', source: 'package.json' },
  ],
}

const setup = (
  handler: Parameters<typeof createFakeRunner>[0] = (command) =>
    command[1] === 'run' && command.includes('--detach') ? { stdout: 'c0ffee\n' } : undefined,
  overrides: Partial<Parameters<typeof containerRunner>[0]> = {},
) => {
  const fake = createFakeRunner(handler)
  const runner = containerRunner({
    engine: 'docker',
    image: 'holtkeeper-worker:test',
    workspace: { hostDir: '/work/co' },
    extraMounts: [{ hostDir: '/work/extra', containerDir: '/checkouts/0', readOnly: true }],
    toolchain,
    limits: { cpus: 1.5, memory: '2g', pids: 256 },
    network: 'none',
    installNetwork: 'bridge',
    env: { CI: '1' },
    envAllowlist: ['HTTPS_PROXY', 'UNSET'],
    hostEnv: { HTTPS_PROXY: 'http://proxy.test:3128', SECRET: 'nope' },
    hostRunner: fake.runner,
    name: 'holtkeeper-job-test',
    ...overrides,
  })
  return { runner, calls: fake.calls }
}

const sandbox = (network: string) => [
  '--init',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,exec,nosuid,nodev,size=2g',
  '--security-opt',
  'no-new-privileges',
  '--cap-drop',
  'ALL',
  '--user',
  '10001:10001',
  '--network',
  network,
  '--cpus',
  '1.5',
  '--memory',
  '2g',
  '--pids-limit',
  '256',
  '--mount',
  'type=volume,source=holtkeeper-mise-cache,target=/mise',
]

describe('containerRunner', () => {
  test('start installs tools with network, then starts the job container without', async () => {
    const { runner, calls } = setup()
    await runner.start()
    await runner.start()
    expect(calls.map((call) => call.command)).toEqual([
      [
        'docker',
        'run',
        '--rm',
        ...sandbox('bridge'),
        '--workdir',
        '/tmp',
        '--label',
        'holtkeeper.role=install',
        '-e',
        'HTTPS_PROXY',
        'holtkeeper-worker:test',
        'mise',
        'install',
        'node@20',
        'pnpm@9.12.0',
      ],
      [
        'docker',
        'run',
        '--detach',
        '--rm',
        '--name',
        'holtkeeper-job-test',
        ...sandbox('none'),
        '--mount',
        'type=bind,source=/work/co,target=/workspace',
        '--mount',
        'type=bind,source=/work/extra,target=/checkouts/0,readonly',
        '--workdir',
        '/workspace',
        '--label',
        'holtkeeper.role=job',
        'holtkeeper-worker:test',
        'sleep',
        'infinity',
      ],
    ])
    expect(calls[0]?.options.env).toEqual({ HTTPS_PROXY: 'http://proxy.test:3128' })
    expect(runner.containerId).toBe('c0ffee')
  })

  test('without tools there is no install step', async () => {
    const { runner, calls } = setup(undefined, { toolchain: { tools: [] } })
    await runner.start()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command.slice(0, 3)).toEqual(['docker', 'run', '--detach'])
  })

  test('a failed start throws and can be retried', async () => {
    let fail = true
    const { runner } = setup((command) =>
      command.includes('--detach')
        ? fail
          ? { exitCode: 125, stderr: 'Unable to find image' }
          : { stdout: 'id2' }
        : undefined,
    )
    expect(await failure(runner.start())).toContain('Unable to find image')
    fail = false
    await runner.start()
    expect(runner.containerId).toBe('id2')
  })

  test('run execs with a mapped cwd, per-command env and the mise prefix', async () => {
    const { runner, calls } = setup((command) =>
      command.includes('--detach')
        ? { stdout: 'c0ffee' }
        : command[1] === 'exec'
          ? { stdout: 'v20.11.1\n' }
          : undefined,
    )
    await runner.start()
    const result = await runner.run(['node', '--version'], {
      cwd: '/work/co/apps/web',
      env: { NODE_ENV: 'test', CI: undefined, 'BAD-NAME': 'x' },
    })
    expect(result).toEqual({ exitCode: 0, stdout: 'v20.11.1\n', stderr: '' })
    const exec = calls.at(-1)
    const pidFile = exec?.command[exec.command.indexOf('echo $$ > "$0"; exec "$@"') + 1]
    expect(pidFile).toMatch(/^\/tmp\/\.holtkeeper-exec-[\w-]+\.pid$/)
    expect(exec?.command).toEqual([
      'docker',
      'exec',
      '--workdir',
      '/workspace/apps/web',
      '-e',
      'HTTPS_PROXY',
      '-e',
      'MISE_IGNORED_CONFIG_PATHS',
      '-e',
      'NODE_ENV',
      'c0ffee',
      'setsid',
      '-w',
      'sh',
      '-c',
      'echo $$ > "$0"; exec "$@"',
      pidFile ?? '',
      'mise',
      'exec',
      'node@20',
      'pnpm@9.12.0',
      '--',
      'node',
      '--version',
    ])
    expect(exec?.options.env).toEqual({
      HTTPS_PROXY: 'http://proxy.test:3128',
      MISE_IGNORED_CONFIG_PATHS: '/workspace:/checkouts/0',
      NODE_ENV: 'test',
    })
    expect(exec?.command.join(' ')).not.toContain('test')
  })

  test('run rejects directories outside the mounts and before start', async () => {
    const { runner } = setup()
    expect(await failure(runner.run(['ls'], { cwd: '/work/co' }))).toContain('call start()')
    await runner.start()
    expect(await failure(runner.run(['ls'], { cwd: '/etc' }))).toContain('not inside a directory')
    expect(await failure(runner.run(['ls'], { cwd: '/work/co/../other' }))).toContain('not inside')
  })

  test('non-zero exit codes are results; engine failures reject', async () => {
    let stderr = 'boom'
    const { runner } = setup((command) =>
      command.includes('--detach')
        ? { stdout: 'c0ffee' }
        : command[1] === 'exec'
          ? { exitCode: command.includes('false') ? 1 : 126, stderr }
          : undefined,
    )
    await runner.start()
    expect(await runner.run(['false'], { cwd: '/work/co' })).toMatchObject({ exitCode: 1 })
    expect(await runner.run(['x'], { cwd: '/work/co' })).toMatchObject({ exitCode: 126 })
    stderr = 'Error response from daemon: container c0ffee is not running'
    expect(await failure(runner.run(['x'], { cwd: '/work/co' }))).toContain('docker exec failed')
  })

  test('a timeout kills the process group of the command', async () => {
    let release: (() => void) | undefined
    const { runner, calls } = setup((command) => {
      if (command.includes('--detach')) return { stdout: 'c0ffee' }
      if (command.includes('setsid'))
        return new Promise((resolve) => {
          release = () => resolve({ exitCode: 137 })
        })
      if (command.includes('kill -KILL -- -"$(cat "$0")" 2>/dev/null || kill -KILL "$(cat "$0")"'))
        release?.()
      return undefined
    })
    await runner.start()
    const result = await runner.run(['sleep', '100'], { cwd: '/work/co', timeoutMs: 5 })
    expect(result.exitCode).toBe(137)
    const kill = calls.at(-1)?.command
    expect(kill?.slice(0, 5)).toEqual(['docker', 'exec', 'c0ffee', 'sh', '-c'])
    expect(calls.find((call) => call.command.includes('setsid'))?.options.timeoutMs).toBe(10_005)
    expect(runner.containerId).toBe('c0ffee')
  })

  test('an abort kills the container when the group kill fails', async () => {
    let release: (() => void) | undefined
    const { runner, calls } = setup((command) => {
      if (command.includes('--detach')) return { stdout: 'c0ffee' }
      if (command.includes('setsid'))
        return new Promise((resolve) => {
          release = () => resolve({ exitCode: 137 })
        })
      if (command[2] === 'c0ffee' && command[1] === 'exec') return { exitCode: 1 }
      if (command[1] === 'kill') release?.()
      return undefined
    })
    await runner.start()
    const controller = new AbortController()
    const running = runner.run(['sleep', '100'], { cwd: '/work/co', signal: controller.signal })
    controller.abort()
    expect((await running).exitCode).toBe(137)
    expect(calls.at(-1)?.command).toEqual(['docker', 'kill', 'c0ffee'])
    expect(runner.containerId).toBeUndefined()
    expect(
      await failure(runner.run(['ls'], { cwd: '/work/co', signal: controller.signal })),
    ).not.toBe('resolved')
  })

  test('stop removes the container once', async () => {
    const { runner, calls } = setup()
    await runner.stop()
    expect(calls).toHaveLength(0)
    await runner.start()
    await runner.stop()
    await runner.stop()
    expect(calls.at(-1)?.command).toEqual(['docker', 'rm', '--force', 'c0ffee'])
    expect(calls.filter((call) => call.command[1] === 'rm')).toHaveLength(1)
  })

  test('podman uses the same arguments', async () => {
    const { runner, calls } = setup(undefined, { engine: 'podman', toolchain: { tools: [] } })
    await runner.start()
    expect(calls[0]?.command[0]).toBe('podman')
  })

  test('paths with commas cannot be mounted', async () => {
    const { runner } = setup(undefined, { workspace: { hostDir: '/work/a,b' } })
    expect(await failure(runner.start())).toContain('comma')
  })
})

describe('helpers', () => {
  test('containerPath picks the most specific mount', () => {
    const mounts = [
      { hostDir: '/a', containerDir: '/workspace' },
      { hostDir: '/a/nested', containerDir: '/nested' },
    ]
    expect(containerPath('/a', mounts)).toBe('/workspace')
    expect(containerPath('/a/x/y', mounts)).toBe('/workspace/x/y')
    expect(containerPath('/a/nested/z', mounts)).toBe('/nested/z')
    expect(() => containerPath('/ab', mounts)).toThrow()
  })

  test('networksFor maps the policy', () => {
    expect(networksFor('none')).toEqual({ network: 'none', installNetwork: 'none' })
    expect(networksFor('install')).toEqual({ network: 'none', installNetwork: 'bridge' })
    expect(networksFor('full')).toEqual({ network: 'bridge', installNetwork: 'bridge' })
  })

  test('detectEngine prefers docker', () => {
    expect(detectEngine(() => '/bin/x')).toBe('docker')
    expect(detectEngine((binary) => (binary === 'podman' ? '/bin/podman' : null))).toBe('podman')
    expect(detectEngine(() => null)).toBe('docker')
  })
})

describe('localMiseRunner', () => {
  test('installs once and prefixes commands with mise exec', async () => {
    const fake = createFakeRunner()
    const runner = localMiseRunner({
      toolchain,
      hostRunner: fake.runner,
      hostEnv: {},
      env: { CI: '1' },
      ignoreConfigIn: ['/work/co'],
    })
    await runner.start()
    await runner.run(['pnpm', 'install'], { cwd: '/work/co', env: { CI: '0' } })
    await runner.stop()
    expect(fake.calls.map((call) => call.command)).toEqual([
      ['mise', 'install', 'node@20', 'pnpm@9.12.0'],
      ['mise', 'exec', 'node@20', 'pnpm@9.12.0', '--', 'pnpm', 'install'],
    ])
    expect(fake.calls[1]?.options).toEqual({
      cwd: '/work/co',
      env: { MISE_IGNORED_CONFIG_PATHS: '/work/co', CI: '0' },
    })
  })

  test('passes commands through without tools', async () => {
    const fake = createFakeRunner()
    const runner = localMiseRunner({
      toolchain: { tools: [] },
      hostRunner: fake.runner,
      hostEnv: { PATH: '/bin', HOLTKEEPER_VAULT_KEY: 'vault' },
    })
    await runner.start()
    await runner.run(['git', 'status'], { cwd: '/x' })
    expect(fake.calls.map((call) => call.command)).toEqual([['git', 'status']])
    expect(fake.calls[0]?.options.env).toEqual({ PATH: '/bin', HOLTKEEPER_VAULT_KEY: undefined })
  })

  test('removes every host variable outside the allowlist, also from mise install', async () => {
    const fake = createFakeRunner()
    const runner = localMiseRunner({
      toolchain,
      hostRunner: fake.runner,
      hostEnv: {
        PATH: '/usr/bin',
        HOME: '/tmp',
        LC_ALL: 'C.UTF-8',
        MISE_DATA_DIR: '/mise',
        MISE_GITHUB_TOKEN: 'ghp',
        HTTPS_PROXY: 'http://proxy.test:3128',
        GOPROXY: 'https://goproxy.test',
        GITLAB_TOKEN: 'glpat',
        AWS_SECRET_ACCESS_KEY: 'aws',
        HOLTKEEPER_VAULT_KEY: 'vault',
        HOLTKEEPER_DATABASE_URL: 'postgres://u:p@db/h',
        HOLTKEEPER_S3_SECRET_ACCESS_KEY: 's3',
        HOLTKEEPER_SESSION_SECRET: 'session',
        HOLTKEEPER_ROOT_PASSWORD: 'root',
        HOLTKEEPER_WEBHOOK_SECRET: 'hook',
      },
      envAllowlist: ['GOPROXY', 'HOLTKEEPER_VAULT_KEY', 'HOLTKEEPER_*'],
      env: { CI: '1' },
    })
    await runner.start()
    await runner.run(['go', 'test'], { cwd: '/work/co', env: { GOFLAGS: '-mod=mod' } })
    expect(fake.calls.map((call) => kept(call.options.env))).toEqual([
      {
        PATH: '/usr/bin',
        HOME: '/tmp',
        LC_ALL: 'C.UTF-8',
        MISE_DATA_DIR: '/mise',
        HTTPS_PROXY: 'http://proxy.test:3128',
        GOPROXY: 'https://goproxy.test',
        CI: '1',
      },
      {
        PATH: '/usr/bin',
        HOME: '/tmp',
        LC_ALL: 'C.UTF-8',
        MISE_DATA_DIR: '/mise',
        HTTPS_PROXY: 'http://proxy.test:3128',
        GOPROXY: 'https://goproxy.test',
        CI: '1',
        GOFLAGS: '-mod=mod',
      },
    ])
    for (const call of fake.calls)
      expect(Object.keys(call.options.env ?? {})).toContain('HOLTKEEPER_VAULT_KEY')
  })

  test('the runner and run env still set variables the host has', async () => {
    const fake = createFakeRunner()
    const runner = localMiseRunner({
      toolchain,
      hostRunner: fake.runner,
      hostEnv: { NPM_CONFIG_REGISTRY: 'https://internal.test' },
      env: { NPM_CONFIG_REGISTRY: 'https://egress.test' },
    })
    await runner.run(['npm', 'ci'], { cwd: '/x' })
    expect(fake.calls[0]?.options.env?.['NPM_CONFIG_REGISTRY']).toBe('https://egress.test')
  })

  test.skipIf(!Bun.which('env'))('a real command sees no Holtkeeper secrets', async () => {
    const names = ['HOLTKEEPER_VAULT_KEY', 'HOLTKEEPER_TEST_SECRET', 'GITLAB_TOKEN']
    const previous = names.map((name) => Bun.env[name])
    for (const name of names) Bun.env[name] = 'leaked'
    try {
      const runner = localMiseRunner({ toolchain: { tools: [] }, hostRunner: localRunner })
      const result = await runner.run(['env'], { cwd: process.cwd(), env: { JOB_VAR: 'set' } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('leaked')
      expect(result.stdout).toContain('JOB_VAR=set')
      expect(result.stdout).toContain('PATH=')
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete Bun.env[name]
        else Bun.env[name] = previous[index]
      })
    }
  })

  test('a failed install throws', async () => {
    const fake = createFakeRunner(() => ({ exitCode: 1, stderr: 'no such version' }))
    const runner = localMiseRunner({ toolchain, hostRunner: fake.runner })
    expect(await failure(runner.start())).toContain('no such version')
  })
})

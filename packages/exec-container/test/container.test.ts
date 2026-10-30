import { afterAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'
import { detectToolchain } from '@holtkeeper/toolchain'

import { containerRunner } from '../src/index.ts'

// Needs the worker image: docker build -t holtkeeper-worker:dev docker/worker
const image = Bun.env.HOLTKEEPER_WORKER_IMAGE ?? 'holtkeeper-worker:dev'
const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test.skipIf(!Bun.env.HOLTKEEPER_DOCKER_TESTS)(
  'runs node from .nvmrc inside a sandboxed container',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-container-'))
    dirs.push(dir)
    await writeFile(join(dir, '.nvmrc'), '20\n')
    await writeFile(join(dir, 'mise.toml'), '[env]\nFROM_REPO = "yes"\n')
    await mkdir(join(dir, 'sub'))
    const toolchain = await detectToolchain(dir)
    expect(toolchain.tools).toEqual([{ name: 'node', version: '20', source: '.nvmrc' }])

    const runner = containerRunner({
      image,
      workspace: { hostDir: dir },
      toolchain,
      network: 'none',
      installNetwork: 'bridge',
      limits: { cpus: 1, memory: '1g', pids: 256 },
      hostRunner: localRunner,
    })
    try {
      await runner.start()
      const version = await runner.run(['node', '--version'], { cwd: join(dir, 'sub') })
      expect(version.exitCode).toBe(0)
      expect(version.stdout).toMatch(/^v20\./)

      const env = await runner.run(
        ['sh', '-c', 'echo "$PWD $(id -u) ${SECRET:-} ${FROM_REPO:-no}"'],
        {
          cwd: dir,
          env: { SECRET: 'per-command' },
        },
      )
      expect(env.stdout.trim()).toBe('/workspace 10001 per-command no')

      const offline = await runner.run(['curl', '-sS', '--max-time', '3', 'https://example.com'], {
        cwd: dir,
      })
      expect(offline.exitCode).not.toBe(0)

      const readOnly = await runner.run(['touch', '/usr/x'], { cwd: dir })
      expect(readOnly.exitCode).not.toBe(0)

      const slow = await runner.run(['sleep', '30'], { cwd: dir, timeoutMs: 500 })
      expect(slow.exitCode).not.toBe(0)
      expect((await runner.run(['true'], { cwd: dir })).exitCode).toBe(0)
    } finally {
      await runner.stop()
    }
  },
  600_000,
)

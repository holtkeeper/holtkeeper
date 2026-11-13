import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'
import { createFakeRunner } from '@holtkeeper/exec/testing'

import { extractGoUsages, extractUsages, usagesDataSchema } from '../src/index.ts'

const repo: Record<string, string> = {
  'go.mod': `module example.com/acme/widgets

go 1.22

require gitlab.example/shapes/libs/geom v1.4.0
`,
  'main.go': `package main

import "gitlab.example/shapes/libs/geom"

func main() {
\tp := geom.NewPoint(1, 2)
\tp.Move(3)
\t_ = p.X
}
`,
  'gen/skip.go': 'package gen\n',
}

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

const typed = (line: number, column: number, member: string, extra: object = {}) => ({
  file: 'main.go',
  line,
  column,
  importPath: 'gitlab.example/shapes/libs/geom',
  export: 'Point',
  member,
  kind: 'member',
  ...extra,
})

let dir: string
let work: string
let fixture: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usages-go-typed-'))
  await write(dir, repo)
  work = await mkdtemp(join(tmpdir(), 'usages-go-work-'))
  await write(work, {
    'go.work': 'go 1.22\n\nuse (\n\t./api\n\t./worker\n)\n',
    'api/go.mod': 'module example.com/acme/api\n\ngo 1.22\n',
    'worker/go.mod': 'module example.com/acme/worker\n\ngo 1.22\n',
    'tools/go.mod': 'module example.com/acme/tools\n\ngo 1.22\n',
  })
  fixture = await mkdtemp(join(tmpdir(), 'usages-go-fixture-'))
  await cp(join(import.meta.dir, 'fixtures/go-typed'), fixture, { recursive: true })
})

afterAll(async () => {
  await Promise.all([dir, work, fixture].map((path) => rm(path, { recursive: true, force: true })))
})

describe('extractGoUsages with the Go type checker', () => {
  test('merges typed sites, dropping duplicates, excluded files and the standard library', async () => {
    const { runner } = createFakeRunner((command) =>
      command[1] === 'run'
        ? {
            stdout: JSON.stringify({
              packages: 1,
              sites: [
                typed(7, 4, 'Move', { kind: 'call' }),
                typed(8, 8, 'X'),
                typed(6, 7, 'NewPoint'),
                typed(1, 1, 'Hidden', { file: 'gen/skip.go' }),
                typed(8, 6, 'Len', { importPath: 'strings', export: 'Builder' }),
              ],
            }),
          }
        : {},
    )
    const result = await extractGoUsages({ dir, runner, exclude: ['gen/**'] })
    expect(result?.types).toEqual({
      status: 'used',
      projects: ['example.com/acme/widgets'],
      sites: 2,
    })
    const geom = result?.packages.find((pkg) => pkg.name === 'gitlab.example/shapes/libs/geom')
    expect(geom).toMatchObject({ versions: ['v1.4.0'], count: 3 })
    const point = geom?.exports.find((item) => item.name === 'Point')
    expect(point).toMatchObject({
      subpath: '.',
      count: 2,
      kinds: { call: 1, member: 1 },
      members: [
        { name: 'Move', count: 1 },
        { name: 'X', count: 1 },
      ],
    })
    expect(point?.sites.map((site) => [site.line, site.column, site.typed])).toEqual([
      [7, 4, true],
      [8, 8, true],
    ])
    expect(point?.sites[0]?.snippet).toContain('p.Move(3)')
    const newPoint = geom?.exports.find((item) => item.name === 'NewPoint')
    expect(newPoint?.sites[0]?.typed).toBeUndefined()
  })

  test('keeps the syntactic result when the checker fails or is off', async () => {
    const lines: string[] = []
    const { runner } = createFakeRunner((command) =>
      command[1] === 'run'
        ? { exitCode: 1, stderr: 'go: gitlab.example/shapes/libs/geom@v1.4.0: 404 Not Found' }
        : {},
    )
    const failed = await extractGoUsages({ dir, runner, log: (line) => lines.push(line) })
    expect(failed?.types.status).toBe('failed')
    expect(failed?.types.reason).toContain('go: .: go: gitlab.example/shapes/libs/geom@v1.4.0')
    expect(failed?.packages[0]?.exports.map((item) => item.name)).toEqual(['NewPoint'])
    expect(lines.some((line) => line.startsWith('usages: Go type checker failed'))).toBe(true)

    const off = createFakeRunner()
    const skipped = await extractGoUsages({ dir, runner: off.runner, types: false })
    expect(skipped?.types).toEqual({ status: 'skipped', reason: 'go: turned off' })
    expect(off.calls).toEqual([])
  })

  test('checks go.work members together and other modules alone', async () => {
    const { runner, calls } = createFakeRunner((command) =>
      command[1] === 'run' ? { stdout: JSON.stringify({ packages: 0, sites: [] }) } : {},
    )
    const result = await extractGoUsages({ dir: work, runner })
    expect(result?.types.status).toBe('used')
    const runs = calls.filter((call) => call.command[1] === 'run').map((call) => call.command)
    expect(runs.map((command) => command.slice(5, 9))).toEqual([
      ['-C', '..', '-gowork', '../go.work'],
      ['-C', '../tools', '-gowork', 'off'],
    ])
    expect(runs[0]?.slice(-2)).toEqual(['./api/...', './worker/...'])
    expect(await readdir(work)).not.toContain(expect.stringMatching(/^\.holtkeeper/))
  })

  test('extractUsages passes the runner through', async () => {
    const { runner } = createFakeRunner((command) =>
      command[1] === 'run'
        ? { stdout: JSON.stringify({ packages: 1, sites: [typed(8, 8, 'X')] }) }
        : {},
    )
    const data = await extractUsages({ dir, runner })
    expect(usagesDataSchema.safeParse(data).success).toBe(true)
    expect(data.types).toMatchObject({ status: 'used', sites: 1 })
  })

  test.skipIf(!Bun.which('go'))(
    'type-checks a real module against a locally replaced one',
    async () => {
      const checkout = join(fixture, 'app')
      const result = await extractGoUsages({ dir: checkout, runner: localRunner })
      expect(result?.types).toEqual({
        status: 'used',
        projects: ['example.com/acme/app'],
        sites: 11,
      })
      const shapes = result?.packages.find((pkg) => pkg.name === 'example.com/acme/shapes')
      expect(shapes).toMatchObject({ local: true, replaced: true })
      const byName = Object.fromEntries(
        (shapes?.exports ?? []).map((item) => [`${item.subpath} ${item.name}`, item]),
      )
      expect(byName['./canvas Canvas']?.members).toEqual([
        { name: 'Options', count: 3 },
        { name: 'Width', count: 3 },
        { name: 'Draw', count: 1 },
        { name: 'Reset', count: 1 },
      ])
      expect(byName['./canvas Options']?.members).toEqual([
        { name: 'Color', count: 2 },
        { name: 'Scale', count: 1 },
      ])
      expect(byName['./canvas New']?.kinds).toEqual({ call: 3 })
      const color = byName['./canvas Options']?.sites.find((site) => site.file === 'main.go')
      expect(color).toMatchObject({ line: 21, column: 30, kind: 'member', typed: true })
      expect(await readdir(checkout)).not.toContain(expect.stringMatching(/^\.holtkeeper/))
    },
    120_000,
  )
})

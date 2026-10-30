import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeDependencies } from '@holtkeeper/depgraph'
import { createFakeRunner } from '@holtkeeper/exec/testing'

import { goEnv, goSource } from './source.ts'

const captured = await Bun.file(
  join(import.meta.dir, '../test/fixtures/workspace/go-mod-graph.txt'),
).text()

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-depgraph-go-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

async function writeWorkspace() {
  await Bun.write(join(dir, 'go.work'), 'go 1.22\n\nuse (\n\t./app\n\t./lib // library\n)\n')
  await Bun.write(
    join(dir, 'app/go.mod'),
    'module example.com/app\n\ngo 1.22\n\nrequire (\n\texample.com/lib v0.0.0\n\tgolang.org/x/text v0.3.0\n)\n\nreplace example.com/lib => ../lib\n',
  )
  await Bun.write(
    join(dir, 'lib/go.mod'),
    'module example.com/lib\n\ngo 1.22\n\nrequire golang.org/x/text v0.9.0\n\nrequire golang.org/x/net v0.10.0 // indirect\n',
  )
}

describe('goSource', () => {
  test('reads go.work workspaces and one go mod graph for the workspace', async () => {
    await writeWorkspace()
    const { runner, calls } = createFakeRunner(() => ({ stdout: captured }))
    const source = goSource({ runner })
    expect(await source.detect(dir)).toBe(true)
    const data = await analyzeDependencies({ dir, sources: [source] })

    expect(calls).toEqual([
      {
        command: ['go', 'mod', 'graph'],
        options: {
          cwd: dir,
          env: { ...goEnv, GOWORK: join(dir, 'go.work') },
          timeoutMs: undefined,
        },
      },
    ])
    const [workspaces, packages] = data.layers
    expect(workspaces?.graph).toEqual({
      nodes: [
        {
          id: 'example.com/app',
          name: 'example.com/app',
          ecosystem: 'Go',
          kind: 'workspace',
          path: 'app',
        },
        {
          id: 'example.com/lib',
          name: 'example.com/lib',
          ecosystem: 'Go',
          kind: 'workspace',
          path: 'lib',
        },
      ],
      edges: [{ from: 'example.com/app', to: 'example.com/lib', kind: 'prod' }],
    })
    expect(
      packages?.graph.nodes.some((node) => node.name === 'go' || node.name === 'toolchain'),
    ).toBe(false)
    expect(packages?.graph.edges).toContainEqual({
      from: 'example.com/app',
      to: 'example.com/lib',
      kind: 'prod',
    })

    expect(
      packages?.duplicates.map((duplicate) => ({
        name: duplicate.name,
        versions: duplicate.versions.map(
          (version) => `${version.version}${version.selected ? ' (selected)' : ''}`,
        ),
      })),
    ).toEqual([
      { name: 'golang.org/x/net', versions: ['v0.6.0', 'v0.10.0 (selected)'] },
      { name: 'golang.org/x/sys', versions: ['v0.5.0', 'v0.8.0 (selected)'] },
      { name: 'golang.org/x/text', versions: ['v0.3.0', 'v0.9.0 (selected)'] },
      { name: 'golang.org/x/tools', versions: ['v0.1.12', 'v0.6.0 (selected)'] },
    ])
    const text = packages?.duplicates.find((duplicate) => duplicate.name === 'golang.org/x/text')
    expect(text?.versions[0]).toEqual({
      version: 'v0.3.0',
      id: 'golang.org/x/text@v0.3.0',
      selected: false,
      dependents: ['example.com/app'],
      path: ['example.com/app', 'golang.org/x/text@v0.3.0'],
    })
  })

  test('runs go mod graph per module without go.work', async () => {
    await Bun.write(join(dir, 'a/go.mod'), 'module example.com/a\n\ngo 1.22\n')
    await Bun.write(
      join(dir, 'b/go.mod'),
      'module example.com/b\n\ngo 1.22\n\nrequire example.com/a v1.0.0\n',
    )
    await Bun.write(join(dir, 'node_modules/x/go.mod'), 'module example.com/ignored\n')
    const { runner, calls } = createFakeRunner((_, options) => ({
      stdout: options.cwd.endsWith('/b')
        ? 'example.com/b example.com/a@v1.0.0\nexample.com/b go@1.22\n'
        : '',
    }))
    const layers = await goSource({ runner }).load(dir)
    expect(calls.map((call) => [call.options.cwd, call.options.env?.GOWORK])).toEqual([
      [join(dir, 'a'), 'off'],
      [join(dir, 'b'), 'off'],
    ])
    expect(layers.map((layer) => [layer.id, layer.source])).toEqual([
      ['workspaces', 'go.mod'],
      ['packages', 'go mod graph (a)'],
      ['packages', 'go mod graph (b)'],
    ])
    expect(layers[0]?.graph.edges).toEqual([
      { from: 'example.com/b', to: 'example.com/a', kind: 'prod' },
    ])
    expect(layers[2]?.graph.edges).toEqual([
      { from: 'example.com/b', to: 'example.com/a', kind: 'prod' },
    ])
  })

  test('reports a failing go command as an analysis error', async () => {
    await Bun.write(join(dir, 'go.mod'), 'module example.com/x\n')
    const { runner } = createFakeRunner(() => ({ exitCode: 1, stderr: 'go: no network' }))
    const data = await analyzeDependencies({ dir, sources: [goSource({ runner })] })
    expect(data.layers).toEqual([])
    expect(data.errors).toEqual([
      { source: 'go', message: '`go mod graph` exited with 1:\ngo: no network' },
    ])
  })

  test('detects nothing without Go files', async () => {
    expect(await goSource({ runner: createFakeRunner().runner }).detect(dir)).toBe(false)
  })
})

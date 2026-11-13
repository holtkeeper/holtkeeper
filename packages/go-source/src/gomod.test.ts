import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverGoModules, findGoModules, parseGoMod, parseGoWork } from './gomod.ts'

describe('parseGoMod', () => {
  test('parses module, go and require directives in both forms', () => {
    expect(
      parseGoMod(
        'module "example.com/x" // comment\n\ngo 1.22\n\nrequire a.com/b v1.0.0\nrequire (\n\tc.com/d v0.2.0 // indirect\n\n\te.com/f v1.2.3-0.20240101000000-abcdef123456\n)\n',
      ),
    ).toEqual({
      module: 'example.com/x',
      go: '1.22',
      require: [
        { path: 'a.com/b', version: 'v1.0.0' },
        { path: 'c.com/d', version: 'v0.2.0', indirect: true },
        { path: 'e.com/f', version: 'v1.2.3-0.20240101000000-abcdef123456' },
      ],
      replace: [],
      exclude: [],
    })
  })

  test('keeps indirect only for the indirect marker', () => {
    const mod = parseGoMod(
      'module example.com/x\nrequire (\n\ta.com/b v1.0.0 // indirect; pinned\n\tc.com/d v1.0.0 // not indirect really\n)\n',
    )
    expect(mod.require).toEqual([
      { path: 'a.com/b', version: 'v1.0.0', indirect: true },
      { path: 'c.com/d', version: 'v1.0.0' },
    ])
  })

  test('parses replace with local and module targets, with and without versions', () => {
    const mod = parseGoMod(
      [
        'module example.com/acme/widgets',
        'replace example.com/acme/gears => ../gears',
        'replace (',
        '\texample.com/acme/bolts v1.2.0 => example.com/fork/bolts v1.2.1',
        '\tgitlab.example/shapes/libs/geom => gitlab.example/shapes/libs/geom v0.4.0 // pinned',
        '\texample.com/acme/nuts => ./third_party/nuts',
        '\texample.com/acme/abs => /opt/src/abs',
        ')',
      ].join('\n'),
    )
    expect(mod.replace).toEqual([
      { path: 'example.com/acme/gears', to: '../gears', local: true },
      {
        path: 'example.com/acme/bolts',
        version: 'v1.2.0',
        to: 'example.com/fork/bolts',
        toVersion: 'v1.2.1',
        local: false,
      },
      {
        path: 'gitlab.example/shapes/libs/geom',
        to: 'gitlab.example/shapes/libs/geom',
        toVersion: 'v0.4.0',
        local: false,
      },
      { path: 'example.com/acme/nuts', to: './third_party/nuts', local: true },
      { path: 'example.com/acme/abs', to: '/opt/src/abs', local: true },
    ])
  })

  test('parses exclude in both forms', () => {
    const mod = parseGoMod(
      'module example.com/x\nexclude example.com/a v1.0.0\nexclude (\n\texample.com/b v0.1.0\n\texample.com/b v0.2.0 // broken\n)\n',
    )
    expect(mod.exclude).toEqual([
      { path: 'example.com/a', version: 'v1.0.0' },
      { path: 'example.com/b', version: 'v0.1.0' },
      { path: 'example.com/b', version: 'v0.2.0' },
    ])
  })

  test('does not mistake longer directive names', () => {
    const mod = parseGoMod('module example.com/x\ngodebug default=go1.21\ntoolchain go1.23.1\n')
    expect(mod.go).toBeUndefined()
  })
})

test('parses use directives of go.work', () => {
  expect(parseGoWork('go 1.22\n\nuse ./tools\nuse (\n\t.\n\t./svc/api/ // api\n)\n')).toEqual([
    'tools',
    '.',
    'svc/api/',
  ])
})

describe('module discovery', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'go-source-'))
    const write = async (path: string, text: string) => {
      await mkdir(join(dir, path, '..'), { recursive: true })
      await writeFile(join(dir, path), text)
    }
    await write('go.mod', 'module example.com/acme/widgets\n')
    await write('tools/go.mod', 'module example.com/acme/widgets/tools\n')
    await write('vendor/example.com/x/go.mod', 'module example.com/x\n')
    await write('a/b/c/d/e/go.mod', 'module example.com/deep\n')
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  test('finds go.mod files up to the depth, skipping vendor', async () => {
    expect(await findGoModules(dir)).toEqual(['.', 'tools'])
    expect(await findGoModules(dir, 5)).toEqual(['.', 'a/b/c/d/e', 'tools'])
  })

  test('prefers go.work when there is one', async () => {
    const found = await discoverGoModules(dir)
    expect(found.workspace).toBe(false)
    expect(found.modules.map((module) => module.module)).toEqual([
      'example.com/acme/widgets',
      'example.com/acme/widgets/tools',
    ])
    await writeFile(join(dir, 'go.work'), 'go 1.22\n\nuse ./tools\n')
    const work = await discoverGoModules(dir)
    expect(work.workspace).toBe(true)
    expect(work.modules.map((module) => [module.module, module.dir])).toEqual([
      ['example.com/acme/widgets/tools', 'tools'],
    ])
  })
})

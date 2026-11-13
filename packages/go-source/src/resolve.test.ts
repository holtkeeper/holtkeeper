import { describe, expect, test } from 'bun:test'

import { type GoWorkspaceModule, parseGoMod } from './gomod.ts'
import { isStdlibImport, resolveGoImport } from './resolve.ts'

const module = (dir: string, content: string): GoWorkspaceModule => {
  const mod = parseGoMod(content)
  return { module: mod.module, dir, mod }
}

const root = module(
  '.',
  [
    'module example.com/acme/widgets',
    'require (',
    '\texample.com/acme/gears v1.3.0',
    '\texample.com/acme/gears/v2 v2.1.0',
    '\tgitlab.example/shapes/libs v0.9.0',
    '\tgitlab.example/shapes/libs/geom v0.4.2 // indirect',
    '\texample.com/acme/bolts v1.2.0',
    '\texample.com/acme/nuts v0.1.0',
    '\texample.com/acme/screws v1.0.0',
    ')',
    'replace example.com/acme/bolts v1.2.0 => example.com/fork/bolts v1.2.1',
    'replace example.com/acme/nuts => ./third_party/nuts',
    'replace example.com/acme/screws v0.9.0 => ../screws',
  ].join('\n'),
)
const tools = module('tools', 'module example.com/acme/widgets/tools\n')
const local = module('third_party/nuts', 'module example.com/acme/nuts\n')
const modules = [root, tools, local]

describe('resolveGoImport', () => {
  test('stdlib: first element without a dot', () => {
    expect(resolveGoImport('fmt', root, modules)).toEqual({ kind: 'stdlib' })
    expect(resolveGoImport('net/http/httptest', root, modules)).toEqual({ kind: 'stdlib' })
    expect(isStdlibImport('encoding/json')).toBe(true)
    expect(isStdlibImport('example.com/x')).toBe(false)
  })

  test('own and nested modules are local, longest prefix wins', () => {
    expect(resolveGoImport('example.com/acme/widgets', root, modules)).toEqual({
      kind: 'local',
      module: 'example.com/acme/widgets',
      subpath: '.',
      dir: '.',
    })
    expect(resolveGoImport('example.com/acme/widgets/internal/paint', root, modules)).toMatchObject(
      { kind: 'local', module: 'example.com/acme/widgets', subpath: './internal/paint' },
    )
    expect(resolveGoImport('example.com/acme/widgets/tools/gen', root, modules)).toEqual({
      kind: 'local',
      module: 'example.com/acme/widgets/tools',
      subpath: './gen',
      dir: 'tools',
    })
  })

  test('a module path without a dot is the own module, not stdlib', () => {
    const service = module('.', 'module ordersvc\n')
    expect(resolveGoImport('ordersvc/internal/db', service, [service])).toMatchObject({
      kind: 'local',
      module: 'ordersvc',
      subpath: './internal/db',
    })
    expect(resolveGoImport('ordersvcx/db', service, [service])).toEqual({ kind: 'stdlib' })
  })

  test('required modules by longest prefix at a slash boundary, keeping /vN', () => {
    expect(resolveGoImport('example.com/acme/gears/teeth', root, modules)).toEqual({
      kind: 'external',
      module: 'example.com/acme/gears',
      subpath: './teeth',
      version: 'v1.3.0',
    })
    expect(resolveGoImport('example.com/acme/gears/v2/teeth', root, modules)).toEqual({
      kind: 'external',
      module: 'example.com/acme/gears/v2',
      subpath: './teeth',
      version: 'v2.1.0',
    })
    expect(resolveGoImport('gitlab.example/shapes/libs/geom/area', root, modules)).toEqual({
      kind: 'external',
      module: 'gitlab.example/shapes/libs/geom',
      subpath: './area',
      version: 'v0.4.2',
      indirect: true,
    })
    expect(resolveGoImport('gitlab.example/shapes/libsx', root, modules)).toEqual({
      kind: 'unresolved',
    })
  })

  test('replace with another module keeps the required version and names the replacement', () => {
    expect(resolveGoImport('example.com/acme/bolts', root, modules)).toEqual({
      kind: 'external',
      module: 'example.com/acme/bolts',
      subpath: '.',
      version: 'v1.2.0',
      replacedBy: 'example.com/fork/bolts',
      replacedVersion: 'v1.2.1',
    })
  })

  test('replace with the same module path gives its version', () => {
    const pinned = module(
      '.',
      'module example.com/acme/widgets\nrequire example.com/acme/pins v1.0.0\nreplace example.com/acme/pins => example.com/acme/pins v1.0.3\n',
    )
    expect(resolveGoImport('example.com/acme/pins', pinned, [pinned])).toEqual({
      kind: 'external',
      module: 'example.com/acme/pins',
      subpath: '.',
      version: 'v1.0.3',
      required: 'v1.0.0',
    })
  })

  test('replace with a directory makes the module local', () => {
    expect(resolveGoImport('example.com/acme/nuts/hex', root, modules)).toEqual({
      kind: 'local',
      module: 'example.com/acme/nuts',
      subpath: './hex',
      dir: 'third_party/nuts',
    })
  })

  test('a versioned replace applies only to that version', () => {
    expect(resolveGoImport('example.com/acme/screws', root, modules)).toEqual({
      kind: 'external',
      module: 'example.com/acme/screws',
      subpath: '.',
      version: 'v1.0.0',
    })
  })

  test('a replace outside the repository is local without a dir', () => {
    const nested = module(
      'svc/api',
      'module example.com/acme/api\nrequire example.com/acme/gears v1.0.0\nreplace example.com/acme/gears => ../../../gears\n',
    )
    expect(resolveGoImport('example.com/acme/gears', nested, [nested])).toEqual({
      kind: 'local',
      module: 'example.com/acme/gears',
      subpath: '.',
      replaced: true,
    })
  })
})

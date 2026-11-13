import { expect, test } from 'bun:test'

import { goModuleTags } from './tags.ts'

const modules = [
  { module: 'example.com/acme/widgets', dir: '.' },
  { module: 'example.com/acme/widgets/v2', dir: 'v2' },
  { module: 'example.com/acme/widgets/tools', dir: 'tools' },
  { module: 'example.com/acme/widgets/libs/geom/v3', dir: 'libs/geom' },
  { module: 'example.com/acme/widgets/libs/paint/v4', dir: 'libs/paint/v4' },
]

test('maps root and directory tags to modules', () => {
  expect(
    goModuleTags(
      ['v1.4.0', 'tools/v0.3.1', 'libs/geom/v3.0.0-rc.1', 'release-2026', 'tools/latest'],
      modules,
    ),
  ).toEqual([
    { tag: 'v1.4.0', module: 'example.com/acme/widgets', dir: '.', version: 'v1.4.0' },
    {
      tag: 'tools/v0.3.1',
      module: 'example.com/acme/widgets/tools',
      dir: 'tools',
      version: 'v0.3.1',
    },
    {
      tag: 'libs/geom/v3.0.0-rc.1',
      module: 'example.com/acme/widgets/libs/geom/v3',
      dir: 'libs/geom',
      version: 'v3.0.0-rc.1',
    },
  ])
})

test('a major-version directory takes tags without the major directory', () => {
  expect(goModuleTags(['v2.1.0', 'libs/paint/v4.0.2'], modules)).toEqual([
    { tag: 'v2.1.0', module: 'example.com/acme/widgets/v2', dir: 'v2', version: 'v2.1.0' },
    {
      tag: 'libs/paint/v4.0.2',
      module: 'example.com/acme/widgets/libs/paint/v4',
      dir: 'libs/paint/v4',
      version: 'v4.0.2',
    },
  ])
})

test('the major must agree with the module path', () => {
  expect(goModuleTags(['tools/v2.0.0', 'libs/geom/v2.0.0', 'v3.0.0'], modules)).toEqual([])
})

test('tags that are not semantic versions are ignored', () => {
  expect(goModuleTags(['v1.2', '1.2.3', 'v01.2.3', 'v1.2.3.4'], modules)).toEqual([])
  expect(goModuleTags(['v1.2.3+meta'], modules)).toMatchObject([{ version: 'v1.2.3+meta' }])
})

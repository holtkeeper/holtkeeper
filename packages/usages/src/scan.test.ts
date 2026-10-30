import { describe, expect, test } from 'bun:test'

import { parseSpecifier, scanFile } from './scan.ts'

const known = (name: string) => name.startsWith('@acme/') || name === 'lodash'

const scan = (code: string, file = 'src/a.tsx') => {
  const result = scanFile(file, code, known)
  return {
    ...result,
    sites: result.sites.map((site) =>
      Object.fromEntries(Object.entries(site).filter(([key]) => key !== 'offset')),
    ),
    at: (name: string) => result.candidates.find((c) => c.offset === code.indexOf(name)),
  }
}

describe('parseSpecifier', () => {
  test('splits packages and entry points', () => {
    expect(parseSpecifier('@acme/ui')).toEqual({ name: '@acme/ui', subpath: '.' })
    expect(parseSpecifier('@acme/ui/button/x')).toEqual({ name: '@acme/ui', subpath: './button/x' })
    expect(parseSpecifier('lodash/get')).toEqual({ name: 'lodash', subpath: './get' })
  })

  test('skips paths, built-ins and aliases', () => {
    for (const specifier of [
      './a',
      '../b',
      '/c',
      'node:fs',
      'fs',
      '#internal',
      '@/x',
      '~/y',
      'https://x',
    ])
      expect(parseSpecifier(specifier)).toBeUndefined()
  })
})

describe('scanFile', () => {
  test('follows named, aliased and default imports to their uses', () => {
    const { sites } = scan(`
      import Theme, { Button as B, useStore, type Props } from '@acme/ui'
      const p: Props = {}
      export function Game() {
        const { score, reset } = useStore()
        useStore().level.up()
        return <B variant="ghost" size={2} {...rest}>{Theme.name}</B>
      }
    `)
    expect(sites).toEqual(
      expect.arrayContaining([
        { package: '@acme/ui', subpath: '.', export: 'Props', kind: 'type' },
        {
          package: '@acme/ui',
          subpath: '.',
          export: 'useStore',
          kind: 'member',
          member: '().score',
        },
        {
          package: '@acme/ui',
          subpath: '.',
          export: 'useStore',
          kind: 'member',
          member: '().reset',
        },
        {
          package: '@acme/ui',
          subpath: '.',
          export: 'useStore',
          kind: 'call',
          member: '().level.up',
        },
        {
          package: '@acme/ui',
          subpath: '.',
          export: 'Button',
          kind: 'jsx',
          props: ['variant', 'size', 'children'],
          spread: true,
        },
        { package: '@acme/ui', subpath: '.', export: 'default', kind: 'member', member: 'name' },
      ]),
    )
    expect(sites).toHaveLength(6)
  })

  test('reads namespaces, entry points and require', () => {
    const { sites } = scan(`
      import * as ui from '@acme/ui/game'
      const { get } = require('lodash')
      const { Grid } = ui
      class Board extends ui.Base {}
      let size: ui.Size
      ui.track('start')
      get(x, 'y')
      export default () => <><ui.Panel.Header title="x" /><Grid /></>
    `)
    const short = sites.map(
      (s) =>
        `${s.export}:${s.kind}${s.member ? `:${s.member}` : ''}${s.props ? `:${s.props.join(',')}` : ''}`,
    )
    expect(short.toSorted()).toEqual(
      [
        'Base:extends',
        'Grid:jsx',
        'Panel:jsx:Header:title',
        'Size:type',
        'get:call',
        'track:call',
      ].toSorted(),
    )
    expect(sites.find((s) => s.export === 'Base')?.subpath).toBe('./game')
  })

  test('records re-exports, side-effect imports and unused bindings', () => {
    const { sites } = scan(`
      import '@acme/ui/styles.css'
      import { unused } from '@acme/ui'
      import { Card } from '@acme/ui'
      export { Card }
      export { Badge } from '@acme/ui'
      export * from '@acme/kit'
    `)
    expect(sites.map((s) => `${s.export}:${s.kind}`).toSorted()).toEqual(
      ['*:import', '*:reexport', 'Badge:reexport', 'Card:reexport', 'unused:import'].toSorted(),
    )
  })

  test('ignores unknown packages and relative imports', () => {
    const { sites } = scan(`
      import React from 'react'
      import { x } from './x'
      React.useState(x)
    `)
    expect(sites).toEqual([])
  })

  test('leaves names the imports do not explain to the type checker', () => {
    const code = `
      const store = makeStore()
      store.reset()
      this.engine.start()
      const view = <Fancy open />
    `
    const result = scan(code, 'src/b.tsx')
    expect(result.at('store.reset')?.kind).toBe('member')
    expect(result.candidates.find((c) => c.offset === code.indexOf('reset'))?.kind).toBe('call')
    expect(result.candidates.find((c) => c.offset === code.indexOf('start'))?.kind).toBe('call')
    expect(result.candidates.find((c) => c.offset === code.indexOf('Fancy'))).toMatchObject({
      kind: 'jsx',
      props: ['open'],
    })
  })

  test('reports parse failures without throwing', () => {
    const result = scanFile('src/c.ts', 'import {', known)
    expect(result.sites).toEqual([])
    expect(result.problem).toBeString()
  })
})

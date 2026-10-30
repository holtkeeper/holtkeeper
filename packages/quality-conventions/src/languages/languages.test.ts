import { beforeAll, describe, expect, test } from 'bun:test'

import { parse } from '@ast-grep/napi'

import { collectNames } from '../collect.ts'
import { registerLanguages } from '../dynamic.ts'
import {
  defaultLanguages,
  go,
  java,
  javascript,
  kotlin,
  php,
  python,
  rust,
  typescript,
} from './index.ts'
import type { LanguageSpec } from './types.ts'

beforeAll(async () => {
  await registerLanguages(defaultLanguages)
})

function names(spec: LanguageSpec, path: string, text: string): string[] {
  const parser = spec.parser(path)
  const file = { path, parser, text, root: parse(parser, text).root() }
  return collectNames(spec, file).map((name) => `${name.kind.id}:${name.name}:${name.scope}`)
}

describe('name kinds', () => {
  test('typescript', () => {
    const text = [
      'export const MAX = 1',
      'const pattern = /x/, list = [1]',
      'export function App() { const local = 1; return <div>{local}</div> }',
      'const helper = () => 1',
      'function Row() { const Icon = pick(); return <Icon /> }',
      'const Lazy = lazy(() => null)',
      'class Store { load() {} }',
      'interface Props {}',
      'type Id = string',
      'enum Color { Red, Green = 2 }',
      'const obj = { key: 1 }',
      '',
    ].join('\n')
    expect(names(typescript, 'app.tsx', text)).toEqual([
      'module-constant:MAX:none',
      'module-constant:pattern:module',
      'module-variable:list:module',
      'component:App:none',
      'local-variable:local:local',
      'function:helper:module',
      'component:Row:module',
      'component:Icon:local',
      'component:Lazy:module',
      'class:Store:module',
      'method:load:none',
      'type:Props:module',
      'type:Id:module',
      'enum:Color:module',
      'enum-member:Red:none',
      'enum-member:Green:none',
      'module-variable:obj:module',
    ])
  })

  test('javascript shares the rules without TypeScript-only kinds', () => {
    expect(
      names(javascript, 'a.js', 'const A_B = 1\nfunction run() { let x = 2 }\nclass K {}\n'),
    ).toEqual([
      'module-constant:A_B:module',
      'function:run:module',
      'local-variable:x:local',
      'class:K:module',
    ])
  })

  test('go', () => {
    const text =
      'package x\nconst (\n\tMaxSize = 1\n\tminSize = 2\n)\nvar Global = 1\ntype Store struct{}\nfunc (s Store) Load() {}\nfunc run() { count := 1; for i := range []int{} {}; _ = count }\n'
    expect(names(go, 'x.go', text)).toEqual([
      'exported-constant:MaxSize:none',
      'constant:minSize:none',
      'exported-variable:Global:none',
      'exported-type:Store:none',
      'exported-method:Load:none',
      'function:run:none',
      'local-variable:count:local',
      'local-variable:i:local',
    ])
  })

  test('python', () => {
    const text =
      'MAX = 1\nitems = []\nclass Store:\n    def load(self):\n        total = 1\ndef _helper():\n    pass\n'
    expect(names(python, 'x.py', text)).toEqual([
      'module-constant:MAX:none',
      'module-variable:items:none',
      'class:Store:none',
      'method:load:none',
      'local-variable:total:local',
      'function:_helper:module',
    ])
  })

  test('rust', () => {
    const text =
      'pub const MAX: u8 = 1;\nstatic COUNT: u8 = 0;\nstruct Store;\nenum Kind { One }\nimpl Store { fn load(&self) { let total = 1; } }\nfn run() {}\n'
    expect(names(rust, 'x.rs', text)).toEqual([
      'constant:MAX:none',
      'constant:COUNT:module',
      'type:Store:module',
      'type:Kind:module',
      'enum-variant:One:none',
      'method:load:none',
      'local-variable:total:local',
      'function:run:module',
    ])
  })

  test('java', () => {
    const text =
      'class Store { static final int MAX = 1; int count; void load() { int total = 1; } enum Kind { ONE } }\n'
    expect(names(java, 'Store.java', text)).toEqual([
      'type:Store:none',
      'constant:MAX:none',
      'field:count:none',
      'method:load:none',
      'local-variable:total:local',
      'type:Kind:none',
      'enum-constant:ONE:none',
    ])
  })

  test('kotlin', () => {
    const text =
      'const val MAX = 1\nval items = 2\nclass Store { fun load() { val total = 1 } }\nfun run() {}\n'
    expect(names(kotlin, 'x.kt', text)).toEqual([
      'constant:MAX:none',
      'property:items:none',
      'type:Store:none',
      'method:load:none',
      'local-variable:total:local',
      'function:run:none',
    ])
  })

  test('php', () => {
    const text =
      '<?php\nconst MAX = 1;\nfunction run() { $total = 1; }\nclass Store { private $count; public function load() {} }\n'
    expect(names(php, 'x.php', text)).toEqual([
      'constant:MAX:none',
      'function:run:none',
      'local-variable:total:none',
      'type:Store:none',
      'property:count:none',
      'method:load:none',
    ])
  })
})

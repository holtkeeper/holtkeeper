import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeDependencies, depgraphReport } from '@holtkeeper/depgraph'
import type { DepgraphData } from '@holtkeeper/depgraph'

import { jsSources } from '../src/index.ts'

/** Written at test time so the repository's type check and linter never see the import cycle. */
const sources: Record<string, string> = {
  'packages/a/src/index.ts':
    "import { helper } from '@fx/b'\nimport { state } from './state.js'\nexport const run = () => helper + state.count\n",
  'packages/a/src/state.ts':
    "import { emit } from './events'\nimport type { Options } from './types.ts'\nexport const state = { count: 0, options: {} as Options }\nexport const bump = () => emit(++state.count)\n",
  'packages/a/src/events/index.ts':
    "import { state } from '../state.ts'\nexport const emit = (count: number) => console.log(count, state)\n",
  'packages/a/src/types.ts':
    "import type { run } from './index.ts'\nimport { type bump } from './state.ts'\nexport interface Options { run?: typeof run; bump?: typeof bump }\n",
  'packages/a/src/view.tsx':
    "import styles from './view.css'\nexport const View = () => <div className={styles.root} />\n",
  'packages/a/dist/index.js': "import { run } from '../src/index.js'\nexport default run\n",
  'packages/a/src/node_modules/x/index.js': "import '../../index.ts'\n",
  'packages/b/src/index.ts':
    "import '@fx/c/setup'\nimport '@fx/b/self'\nimport 'debug'\nexport const helper = 1\n",
}

let dir: string
let data: DepgraphData

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-depgraph-js-'))
  await cp(join(import.meta.dir, 'fixtures', 'npm'), dir, { recursive: true })
  await Promise.all(Object.entries(sources).map(([path, code]) => Bun.write(join(dir, path), code)))
  data = await analyzeDependencies({ dir, sources: jsSources() })
})

afterAll(() => rm(dir, { recursive: true, force: true }))

test('builds all three layers', () => {
  expect(data.errors).toEqual([])
  expect(data.layers.map((layer) => [layer.id, layer.source])).toEqual([
    ['workspaces', 'package.json'],
    ['packages', 'package-lock.json'],
    ['modules', 'imports'],
  ])
})

test('maps relative and workspace imports, ignoring type-only imports and build output', () => {
  const modules = data.layers.find((layer) => layer.id === 'modules')
  expect(
    modules?.graph.nodes
      .map((node) => `${node.kind} ${node.id} ${node.workspace ?? ''}`)
      .toSorted(),
  ).toEqual([
    'module packages/a/src/events/index.ts @fx/a',
    'module packages/a/src/index.ts @fx/a',
    'module packages/a/src/state.ts @fx/a',
    'module packages/a/src/types.ts @fx/a',
    'module packages/a/src/view.tsx @fx/a',
    'module packages/b/src/index.ts @fx/b',
    'workspace @fx/b ',
    'workspace @fx/c ',
  ])
  expect(modules?.graph.edges.map((edge) => `${edge.from} -> ${edge.to}`).toSorted()).toEqual([
    'packages/a/src/events/index.ts -> packages/a/src/state.ts',
    'packages/a/src/index.ts -> @fx/b',
    'packages/a/src/index.ts -> packages/a/src/state.ts',
    'packages/a/src/state.ts -> packages/a/src/events/index.ts',
    'packages/b/src/index.ts -> @fx/c',
  ])
})

test('reports the module cycle and the workspace cycle', () => {
  const modules = data.layers.find((layer) => layer.id === 'modules')
  expect(modules?.cycles).toEqual([
    {
      members: ['packages/a/src/events/index.ts', 'packages/a/src/state.ts'],
      path: [
        'packages/a/src/events/index.ts',
        'packages/a/src/state.ts',
        'packages/a/src/events/index.ts',
      ],
    },
  ])

  const report = depgraphReport(data)
  expect(Object.fromEntries(report.metrics.map((metric) => [metric.id, metric.value]))).toEqual({
    workspaces: 3,
    packages: 12,
    duplicates: 2,
    'workspace-cycles': 1,
    'module-cycles': 1,
  })
  const issues = report.sections.find((section) => section.id === 'issues')?.blocks[0]
  expect(issues?.type === 'issues' ? issues.items.map((item) => item.title) : []).toEqual([
    'Workspace cycle: @fx/a → @fx/b → @fx/c → @fx/a',
    'Module cycle: packages/a/src/events/index.ts → packages/a/src/state.ts → packages/a/src/events/index.ts',
    'debug in 2 versions: 2.6.9, 4.4.3',
    'ms in 2 versions: 2.0.0, 2.1.3',
  ])
})

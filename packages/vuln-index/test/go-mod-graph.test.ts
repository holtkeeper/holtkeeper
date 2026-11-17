import { expect, test } from 'bun:test'

import { analyzeLayer } from '@holtkeeper/depgraph'
import { parseGoMod, parseGoModGraph } from '@holtkeeper/depgraph-go'

import { inventoryOf } from '../src/inventory.ts'

const goMod = `module example.com/app

go 1.22

require example.com/widget v1.4.0

require example.com/gizmo v0.3.0 // indirect
`

// `go mod graph` also prints what dependencies require for their own tests and tools; such
// modules (example.com/testkit here) are never compiled into the app.
const graphOutput = `example.com/app go@1.22
example.com/app example.com/widget@v1.4.0
example.com/app example.com/gizmo@v0.3.0
example.com/widget@v1.4.0 example.com/gizmo@v0.2.0
example.com/widget@v1.4.0 example.com/testkit@v2.0.0
example.com/testkit@v2.0.0 example.com/gizmo@v0.1.0
`

test('reads only the modules go.mod requires, at the selected version', () => {
  const graph = parseGoModGraph(graphOutput, [
    { module: 'example.com/app', dir: '.', mod: parseGoMod(goMod) },
  ])
  const inventory = inventoryOf({
    layers: [analyzeLayer({ id: 'packages', source: 'go mod graph', graph })],
    errors: [],
  })
  expect(inventory.packages.map((pkg) => `${pkg.name}@${pkg.version}`).toSorted()).toEqual([
    'example.com/gizmo@0.3.0',
    'example.com/widget@1.4.0',
  ])
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  extractGoUsages,
  extractUsages,
  importPath,
  usagesDataSchema,
  usagesReport,
} from '../src/index.ts'

const goRepo: Record<string, string> = {
  'go.mod': `module example.com/acme/widgets

go 1.22

require (
\tgitlab.example/shapes/libs/geom v1.4.0
\texample.com/acme/colors/v2 v2.1.0
\texample.com/acme/tools v0.0.0-00010101000000-000000000000
\texample.com/acme/unused v0.3.0 // indirect
)

replace example.com/acme/colors/v2 => example.com/fork/colors/v2 v2.1.3

replace example.com/acme/tools => ./tools
`,
  'main.go': `package main

import (
\t"fmt"

\t"example.com/acme/widgets/internal/store"
\t"gitlab.example/shapes/libs/geom"
\tpalette "example.com/acme/colors/v2/palette"
)

func main() {
\tp := geom.NewPoint(1, 2)
\tbox := &geom.Rect{Min: p, Max: geom.Origin}
\tvar shade palette.Shade
\tfmt.Println(box, shade, store.Open())
}
`,
  'internal/store/store.go': `package store

import "example.com/acme/tools/fsutil"

type Store struct {
\tfsutil.Locker
\tname string
}

func Open() *Store { return &Store{} }
`,
  'internal/store/store_test.go': `package store

import (
\t"testing"

\t"gitlab.example/shapes/libs/geom/grid"
)

func TestGrid(t *testing.T) {
\t_ = grid.Cells(3)
}
`,
  'tools/go.mod': 'module example.com/acme/tools\n\ngo 1.22\n',
  'tools/fsutil/lock.go': 'package fsutil\n\ntype Locker struct{}\n',
  'plugins/go.mod': `module example.com/acme/widgets/plugins

go 1.22

require example.com/acme/widgets v1.0.0
`,
  'plugins/blur/blur.go': `package blur

import (
\t_ "example.com/acme/drivers/raw"
\t"example.com/acme/widgets/internal/store"
)

var Default = store.Open
`,
  'vendor/gitlab.example/shapes/libs/geom/geom.go':
    'package geom\n\nimport "example.com/acme/hidden"\n\nvar _ = hidden.X\n',
  'testdata/sample.go': 'package sample\n\nimport "example.com/acme/hidden"\n\nvar _ = hidden.X\n',
  '_scratch/try.go': 'package try\n\nimport "example.com/acme/hidden"\n\nvar _ = hidden.X\n',
}

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

let dir: string
let mixed: string
let empty: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usages-go-'))
  await write(dir, goRepo)
  mixed = await mkdtemp(join(tmpdir(), 'usages-mixed-'))
  await write(mixed, {
    'package.json': JSON.stringify({ name: 'console', dependencies: { 'some-lib': '^1.0.0' } }),
    'web/app.ts': `import { draw } from 'some-lib'\ndraw()\n`,
    'service/go.mod':
      'module gitlab.example/shapes/console\n\ngo 1.22\n\nrequire gitlab.example/shapes/libs/geom v1.5.0\n',
    'service/area.go':
      'package area\n\nimport "gitlab.example/shapes/libs/geom"\n\nvar Unit = geom.Square(1)\n',
  })
  empty = await mkdtemp(join(tmpdir(), 'usages-empty-'))
  await write(empty, { 'README.md': '# nothing to scan\n' })
})

afterAll(async () => {
  await Promise.all([dir, mixed, empty].map((path) => rm(path, { recursive: true, force: true })))
})

describe('extractUsages for Go', () => {
  test('groups uses per module with package subpaths and go.mod versions', async () => {
    const data = await extractUsages({ dir, types: true })
    expect(usagesDataSchema.safeParse(data).success).toBe(true)
    expect(data.types).toEqual({ status: 'skipped', reason: 'go: no command runner' })
    expect(data.files).toBe(5)

    const geom = data.packages.find((pkg) => pkg.name === 'gitlab.example/shapes/libs/geom')
    expect(geom).toMatchObject({
      ecosystem: 'Go',
      versions: ['v1.4.0'],
      ranges: ['v1.4.0'],
      workspaces: ['example.com/acme/widgets'],
    })
    expect(geom?.local).toBeUndefined()
    const byName = Object.fromEntries(
      (geom?.exports ?? []).map((item) => [`${item.subpath} ${item.name}`, item]),
    )
    expect(Object.keys(byName).toSorted()).toEqual([
      '. NewPoint',
      '. Origin',
      '. Rect',
      './grid Cells',
    ])
    expect(byName['. NewPoint']?.kinds).toEqual({ call: 1 })
    expect(byName['. Rect']?.kinds).toEqual({ new: 1 })
    expect(byName['. Rect']?.props.map((prop) => prop.name)).toEqual(['Max', 'Min'])
    expect(byName['./grid Cells']?.sites[0]).toMatchObject({
      file: 'internal/store/store_test.go',
      line: 10,
      kind: 'call',
    })
    expect(importPath('gitlab.example/shapes/libs/geom', './grid')).toBe(
      'gitlab.example/shapes/libs/geom/grid',
    )

    const site = byName['. NewPoint']?.sites[0]
    expect(site).toMatchObject({ file: 'main.go', line: 12, column: 7 })
    expect(site?.snippet).toContain('p := geom.NewPoint(1, 2)')
  })

  test('keeps the required version when another module replaces it', async () => {
    const data = await extractUsages({ dir, types: false })
    const colors = data.packages.find((pkg) => pkg.name === 'example.com/acme/colors/v2')
    expect(colors).toMatchObject({ ecosystem: 'Go', versions: ['v2.1.0'], ranges: ['v2.1.0'] })
    expect(colors?.exports).toMatchObject([
      { name: 'Shade', subpath: './palette', kinds: { type: 1 } },
    ])
  })

  test('marks other modules of the repository and local replaces as local', async () => {
    const data = await extractUsages({ dir, types: false })
    const tools = data.packages.find((pkg) => pkg.name === 'example.com/acme/tools')
    expect(tools).toMatchObject({ local: true, ecosystem: 'Go', versions: [] })
    expect(tools?.exports).toMatchObject([
      { name: 'Locker', subpath: './fsutil', kinds: { extends: 1 } },
    ])

    const own = data.packages.find((pkg) => pkg.name === 'example.com/acme/widgets')
    expect(own).toMatchObject({ local: true, workspaces: ['example.com/acme/widgets/plugins'] })
    expect(own?.exports.map((item) => `${item.subpath} ${item.name}`)).toEqual([
      './internal/store Open',
    ])
  })

  test('skips stdlib, self imports, vendor, testdata, _-prefixed folders and unresolved paths', async () => {
    const lines: string[] = []
    const data = await extractUsages({ dir, types: false, log: (line) => lines.push(line) })
    const names = data.packages.map((pkg) => pkg.name)
    expect(names).not.toContain('fmt')
    expect(names).not.toContain('testing')
    expect(names).not.toContain('example.com/acme/hidden')
    expect(names).not.toContain('example.com/acme/drivers/raw')
    expect(
      data.packages
        .find((pkg) => pkg.name === 'example.com/acme/widgets')
        ?.workspaces.includes('example.com/acme/widgets'),
    ).toBe(false)
    expect(lines.some((line) => line.includes('example.com/acme/drivers/raw'))).toBe(true)
  })

  test('filters by package globs', async () => {
    const data = await extractUsages({ dir, types: false, packages: ['gitlab.example/**'] })
    expect(data.packages.map((pkg) => pkg.name)).toEqual(['gitlab.example/shapes/libs/geom'])
  })

  test('renders a report with go code fences', async () => {
    const data = await extractUsages({ dir, types: false })
    const report = usagesReport(data)
    expect(JSON.stringify(report)).toContain('```go')
  })
})

describe('extractUsages for mixed and empty checkouts', () => {
  test('concatenates JavaScript and Go results', async () => {
    const data = await extractUsages({ dir: mixed, types: false })
    expect(data.types).toEqual({ status: 'skipped', reason: 'turned off' })
    expect(data.packages.map((pkg) => `${pkg.ecosystem ?? 'npm'} ${pkg.name}`).toSorted()).toEqual([
      'Go gitlab.example/shapes/libs/geom',
      'npm some-lib',
    ])
    const geom = data.packages.find((pkg) => pkg.ecosystem === 'Go')
    expect(geom).toMatchObject({
      versions: ['v1.5.0'],
      workspaces: ['gitlab.example/shapes/console'],
    })
  })

  test('returns nothing for a checkout without package.json or Go modules', async () => {
    const data = await extractUsages({ dir: empty, types: false })
    expect(data).toEqual({
      packages: [],
      files: 0,
      types: { status: 'skipped', reason: 'no package.json, go.mod or go.work' },
    })
    expect(await extractGoUsages({ dir: empty })).toBeUndefined()
  })
})

describe('extractGoUsages with go.work', () => {
  test('treats workspace members as local', async () => {
    const work = await mkdtemp(join(tmpdir(), 'usages-work-'))
    try {
      await write(work, {
        'go.work': 'go 1.22\n\nuse (\n\t./api\n\t./worker\n)\n',
        'api/go.mod': 'module example.com/acme/api\n\ngo 1.22\n',
        'api/types/job.go': 'package types\n\ntype Job struct{ ID string }\n',
        'worker/go.mod': 'module example.com/acme/worker\n\ngo 1.22\n',
        'worker/run.go':
          'package worker\n\nimport "example.com/acme/api/types"\n\nfunc Run(j types.Job) string { return j.ID }\n',
      })
      const result = await extractGoUsages({ dir: work })
      expect(result?.modules).toBe(2)
      expect(result?.packages).toMatchObject([
        {
          name: 'example.com/acme/api',
          ecosystem: 'Go',
          local: true,
          workspaces: ['example.com/acme/worker'],
          exports: [{ name: 'Job', subpath: './types', kinds: { type: 1 } }],
        },
      ])
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test('uses the declared package name of a local package whose directory differs', async () => {
    const work = await mkdtemp(join(tmpdir(), 'usages-renamed-'))
    try {
      await write(work, {
        'go.mod': 'module example.com/acme/gadgets\n\ngo 1.22\n',
        'kit/go.mod': 'module example.com/acme/gadgets/kit\n\ngo 1.22\n',
        'kit/sprockets-go/sprocket.go': 'package sprocket\n\nfunc Turn() {}\n',
        'cmd/app/main.go':
          'package main\n\nimport "example.com/acme/gadgets/kit/sprockets-go"\n\nfunc main() { sprocket.Turn() }\n',
      })
      const result = await extractGoUsages({ dir: work })
      expect(result?.packages).toMatchObject([
        {
          name: 'example.com/acme/gadgets/kit',
          local: true,
          exports: [{ name: 'Turn', subpath: './sprockets-go', kinds: { call: 1 } }],
        },
      ])
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test('flags a module replaced by a directory outside discovery as replaced', async () => {
    const work = await mkdtemp(join(tmpdir(), 'usages-fork-'))
    try {
      await write(work, {
        'go.mod':
          'module example.com/acme/gadgets\n\ngo 1.22\n\nrequire example.com/acme/springs v1.0.0\n\nreplace example.com/acme/springs => ../springs\n',
        'main.go':
          'package main\n\nimport "example.com/acme/springs"\n\nfunc main() { springs.Coil() }\n',
      })
      const result = await extractGoUsages({ dir: work })
      expect(result?.packages).toMatchObject([
        { name: 'example.com/acme/springs', local: true, replaced: true, versions: [] },
      ])
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})

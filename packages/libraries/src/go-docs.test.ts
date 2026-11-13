import { describe, expect, test } from 'bun:test'

import { goDocMarkdown, goPackageComment, goPackageDocs } from './go-docs.ts'
import { archiveChunks } from './sources/archive.ts'

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, new TextEncoder().encode(text)]))

describe('goPackageComment', () => {
  test('reads the line comment group above the package clause without directives', () => {
    expect(
      goPackageComment(
        '// Copyright 2026 Example.\n\n//go:build linux\n\n// Package shapes draws shapes.\n//\n//go:generate stringer\n// It is small.\npackage shapes\n',
      ),
    ).toEqual({ name: 'shapes', doc: 'Package shapes draws shapes.\n\nIt is small.' })
  })

  test('reads a block comment and answers an empty doc without one', () => {
    expect(
      goPackageComment('/*\nPackage geom measures.\n\n\tgeom.Area(c)\n*/\npackage geom'),
    ).toEqual({ name: 'geom', doc: 'Package geom measures.\n\n\tgeom.Area(c)' })
    expect(goPackageComment('package bare\n')).toEqual({ name: 'bare', doc: '' })
    expect(goPackageComment('// no package here')).toBeUndefined()
  })
})

test('goDocMarkdown fences code, keeps lists and demotes headings', () => {
  expect(
    goDocMarkdown(
      'Package kit helps.\n\n# Usage\n\nCall it:\n\n\tkit.Run()\n\n\tkit.Stop()\n\nOptions:\n  - fast\n  - safe\nDone.',
    ),
  ).toBe(
    'Package kit helps.\n\n## Usage\n\nCall it:\n\n```go\nkit.Run()\n\nkit.Stop()\n```\n\nOptions:\n- fast\n- safe\n\nDone.',
  )
})

describe('goPackageDocs', () => {
  const module = files({
    'go.mod': 'module example.com/acme/kit/v2',
    'kit.go': '// Package kit is the root.\npackage kit',
    'doc.go': '// Package kit, from doc.go.\npackage kit',
    'draw/draw.go': 'package draw',
    'draw/lines.go': '// Package draw paints.\npackage draw',
    'internal/x/x.go': '// Package x is hidden.\npackage x',
    'cmd/tool/main.go': '// Tool does things.\npackage main',
    'nested/go.mod': 'module example.com/acme/kit/nested',
    'nested/n.go': '// Package nested is its own module.\npackage nested',
    'kit_test.go': '// Package kit_test.\npackage kit_test',
  })

  test('one doc per importable package, doc.go first', () => {
    expect(
      goPackageDocs(module, 'example.com/acme/kit/v2').map(({ importPath, path }) => ({
        importPath,
        path,
      })),
    ).toEqual([
      { importPath: 'example.com/acme/kit/v2', path: 'doc.go' },
      { importPath: 'example.com/acme/kit/v2/draw', path: 'draw/lines.go' },
    ])
  })

  test('archive chunks of a Go module carry package docs linked to pkg.go.dev', () => {
    const chunks = archiveChunks(
      { ecosystem: 'Go', name: 'example.com/acme/kit' },
      'v2.1.0',
      module,
    )
    const draw = chunks.find((chunk) => chunk.path === 'draw/lines.go')
    expect(draw?.headings).toEqual(['Package example.com/acme/kit/v2/draw'])
    expect(draw?.text).toContain('Package draw paints.')
    expect(draw?.url?.startsWith('https://pkg.go.dev/example.com/acme/kit/v2/draw@v2.1.0')).toBe(
      true,
    )
    expect(
      archiveChunks({ ecosystem: 'npm', name: 'kit' }, '1.0.0', module).some((chunk) =>
        chunk.path.endsWith('.go'),
      ),
    ).toBe(false)
  })
})

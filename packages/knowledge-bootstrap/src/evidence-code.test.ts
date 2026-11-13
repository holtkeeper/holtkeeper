import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { listFiles } from '@holtkeeper/quality-tests'

import {
  ADR_CHARS,
  CODE_CHARS,
  README_CHARS,
  collectCodeEvidence,
  directDependencies,
  goLayout,
  goRequires,
  pickDocs,
  trimReadme,
} from './evidence-code.ts'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kb-bootstrap-code-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function write(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    // oxlint-disable-next-line no-await-in-loop -- test setup
    await mkdir(dirname(join(dir, file)), { recursive: true })
    // oxlint-disable-next-line no-await-in-loop -- test setup
    await writeFile(join(dir, file), text)
  }
}

describe('collectCodeEvidence', () => {
  test('reads general evidence, the README, docs, ADRs and the Go layout with stable ids', async () => {
    await write({
      'go.mod': 'module example.com/widgets\n\ngo 1.27\n\nrequire example.com/kit v1.2.0\n',
      Makefile: 'test:\n\tgo test ./...\ngen:\n\tgo generate ./...\n',
      'README.md': `[![build](https://ci.test/badge.svg)](https://ci.test)\n<!-- hidden -->\n# Widgets\n\nServes widgets.\n${'x'.repeat(4_000)}`,
      'CONTRIBUTING.md': '# Contributing\n\nRun `make gen` before pushing.',
      'docs/architecture.md': '# Architecture\n\nWidgets live in memory.',
      'docs/adr/0001-use-kit.md': `# Use kit for retries\n\n${'Because. '.repeat(100)}`,
      'cmd/widgets/main.go': 'package main',
      'internal/widget/widget.go': 'package widget',
      'internal/widget/store.go': 'package widget',
    })
    const items = await collectCodeEvidence(dir, await listFiles(dir))
    const ids = items.map((item) => item.id)
    expect(ids).toContain('manifests')
    expect(ids).toEqual(
      expect.arrayContaining([
        'file:README.md',
        'file:CONTRIBUTING.md',
        'file:docs/architecture.md',
        'file:docs/adr/0001-use-kit.md',
        'go-layout',
      ]),
    )
    const readme = items.find((item) => item.id === 'file:README.md')
    expect(readme?.text.startsWith('# Widgets')).toBeTrue()
    expect(readme?.text.length).toBeLessThanOrEqual(README_CHARS)
    expect(readme?.path).toBe('README.md')
    const adr = items.find((item) => item.id === 'file:docs/adr/0001-use-kit.md')
    expect(adr?.label).toBe('ADR: Use kit for retries')
    expect(adr?.text.length).toBeLessThanOrEqual(ADR_CHARS)
    expect(items.find((item) => item.id === 'go-layout')?.text).toBe(
      'cmd/widgets: 1 Go files\ninternal/widget: 2 Go files',
    )
  })

  test('keeps the total within the cap', async () => {
    const docs = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `docs/adr/${String(index).padStart(4, '0')}-decision.md`,
        `# Decision ${index}\n\n${'y'.repeat(2_000)}`,
      ]),
    )
    await write({ 'README.md': 'z'.repeat(10_000), ...docs })
    const items = await collectCodeEvidence(dir, await listFiles(dir))
    expect(items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(CODE_CHARS)
    expect(items.filter((item) => item.label.startsWith('ADR')).length).toBe(6)
  })
})

describe('helpers', () => {
  test('trimReadme drops badges, comments and HTML-only lines', () => {
    expect(
      trimReadme(
        '<p align="center">\n![logo](logo.png)\n</p>\n[![ci](a)](b) [![cov](c)](d)\n<!-- x -->\n# Title\n\n\n\nText',
      ),
    ).toBe('# Title\n\nText')
  })

  test('pickDocs prefers root docs, then the shortest docs paths, never ADRs', () => {
    expect(
      pickDocs([
        'docs/guides/deep/setup.md',
        'docs/adr/0001.md',
        'docs/a.md',
        'ARCHITECTURE.md',
        'docs/intro.md',
        'notes.txt',
      ]),
    ).toEqual(['ARCHITECTURE.md', 'docs/a.md', 'docs/intro.md'])
  })

  test('goLayout counts Go files per package', () => {
    expect(goLayout(['pkg/kit/a.go', 'pkg/kit/sub/b.go', 'main.go', 'internal/x.go'])).toBe(
      'pkg/kit: 1 Go files\npkg/kit/sub: 1 Go files',
    )
  })

  test('goRequires lists direct requires only', () => {
    expect(
      goRequires(
        'module m\n\nrequire example.com/one v1.0.0\n\nrequire (\n\texample.com/two v2.0.0\n\texample.com/three v0.1.0 // indirect\n)\n',
      ),
    ).toEqual(['example.com/one', 'example.com/two'])
  })

  test('directDependencies reads go.mod and package manifests up to two folders deep', async () => {
    await write({
      'go.mod': 'module m\n\nrequire example.com/kit v1.0.0\n',
      'package.json': JSON.stringify({ dependencies: { 'some-lib': '1' } }),
      'web/package.json': JSON.stringify({ devDependencies: { 'other-lib': '2' } }),
      'a/b/c/package.json': JSON.stringify({ dependencies: { 'too-deep': '1' } }),
    })
    expect([...(await directDependencies(dir, await listFiles(dir)))].toSorted()).toEqual([
      'Go:example.com/kit',
      'npm:other-lib',
      'npm:some-lib',
    ])
  })
})

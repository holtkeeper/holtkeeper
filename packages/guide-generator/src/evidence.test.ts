import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { CommitConventions } from '@holtkeeper/commit-conventions'
import { listFiles } from '@holtkeeper/quality-tests'

import {
  approx,
  buildTags,
  collectGeneral,
  collectTestIds,
  collectTesting,
  commitsText,
  golangciSummary,
  goWorkSummary,
  includeName,
  keyTargetsFirst,
  makeTargets,
} from './evidence.ts'

const fixture = join(import.meta.dir, '../../../fixtures/service')
let dir = ''
let files: string[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guide-evidence-'))
  await cp(fixture, dir, { recursive: true })
  files = await listFiles(dir)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const textOf = (items: { id: string; text: string }[], id: string) =>
  items.find((item) => item.id === id)?.text ?? ''

describe('collectGeneral', () => {
  test('summarizes manifests, CI, lint config, toolchain, layout and docs of the fixture', async () => {
    const items = await collectGeneral(dir, files)
    expect(items.map((item) => item.id)).toEqual([
      'manifests',
      'ci',
      'lint',
      'toolchain',
      'layout',
      'docs',
    ])
    expect(textOf(items, 'manifests')).toContain('module example.com/widgets/service, go 1.27.2')
    expect(textOf(items, 'manifests')).toContain('test (go test ./...)')
    expect(textOf(items, 'manifests')).toContain(
      'web/package.json: widget-web, scripts: build, test',
    )
    expect(textOf(items, 'ci')).toBe(
      '.gitlab-ci.yml, stages: check, build\n  lint (check): make lint\n  test (check): make test\n  build (build): make build',
    )
    expect(textOf(items, 'lint')).toBe('golangci-lint: .golangci.yml — linters: errcheck, govet')
    expect(textOf(items, 'toolchain')).toContain('go 1.27.2 (from mise.toml)')
    expect(textOf(items, 'layout')).toContain('internal/ (2 files): widget')
    expect(textOf(items, 'docs')).toBe(
      'README.md — Widget service\ndocs/architecture.md — Architecture',
    )
    expect(items.map((item) => item.text).join('\n')).not.toContain('fmt.Sprintf')
  })

  test('gives the same evidence for the same checkout', async () => {
    expect(await collectGeneral(dir, files)).toEqual(await collectGeneral(dir, files))
  })
})

describe('Go evidence', () => {
  let goDir = ''
  beforeAll(async () => {
    goDir = await mkdtemp(join(tmpdir(), 'guide-go-'))
    const write = async (file: string, text: string) => {
      await mkdir(dirname(join(goDir, file)), { recursive: true })
      await writeFile(join(goDir, file), text)
    }
    await write('go.work', 'go 1.24\n\nuse (\n\t./gears // main\n\t./shapes\n)\n')
    await write('gears/go.mod', 'module example.com/acme/gears\n\ngo 1.24\n')
    await write('shapes/go.mod', 'module example.com/acme/shapes\n\ngo 1.24\n')
    await write(
      'GNUmakefile',
      'release:\n\tgoreleaser\nlint:\n\t@echo linting\n\tgolangci-lint run ./...\ntest-integration:\n\tgo test -tags=integration ./...\n',
    )
    await write(
      '.golangci.yaml',
      'version: "2"\nlinters:\n  default: standard\n  enable: [revive, gosec]\nformatters:\n  enable: [gofumpt, goimports]\nrun:\n  build-tags: [integration]\n',
    )
    await write(
      '.gitlab-ci.yml',
      'include:\n  - project: shapes/ci-templates\n    ref: v3\n    file: [go/lint.yml, go/test.yml]\n  - local: ci/extra.yml\n.go-test:\n  image: golang\ntest:\n  extends: .go-test\n',
    )
    await write('docs/adr/0001-gears.md', '# Use gears\n')
    await write('docs/runbooks/deploy/rollback.md', '# Rollback\n')
    await write('gears/gear_test.go', '//go:build integration && !windows\n\npackage gears\n')
    await write('gears/spin_test.go', '//go:build integration || e2e\n\npackage gears\n')
    await write('shapes/shape_test.go', 'package shapes\n')
  })
  afterAll(() => rm(goDir, { recursive: true, force: true }))

  test('general evidence reads go.work, key Makefile targets, golangci-lint, CI includes and doc folders', async () => {
    const items = await collectGeneral(goDir, await listFiles(goDir))
    const manifests = textOf(items, 'manifests')
    expect(manifests).toContain('go.work, go 1.24, use: ./gears, ./shapes')
    expect(manifests).toContain(
      'Makefile targets: lint (golangci-lint run ./...), test-integration (go test -tags=integration ./...), release (goreleaser)',
    )
    expect(textOf(items, 'lint')).toBe(
      'golangci-lint: .golangci.yaml — version 2; default standard; linters: revive, gosec; formatters: gofumpt, goimports; build tags: integration',
    )
    expect(textOf(items, 'ci')).toContain(
      'includes: shapes/ci-templates:go/lint.yml+go/test.yml@v3, ci/extra.yml',
    )
    expect(textOf(items, 'ci')).toContain('job templates: .go-test')
    expect(textOf(items, 'ci')).toContain('test: extends .go-test')
    expect(textOf(items, 'docs')).toContain(
      'doc folders: docs/adr, docs/runbooks, docs/runbooks/deploy',
    )
  })

  test('testing evidence lists the build tags Go test files need', async () => {
    const items = await collectTesting(goDir, await listFiles(goDir))
    expect(textOf(items, 'test-setup')).toContain(
      'Go test files behind build tags (run with go test -tags): integration (2 files), e2e (1 files)',
    )
    expect(textOf(items, 'test-scripts')).toContain(
      'make test-integration: go test -tags=integration ./...',
    )
  })

  test('helpers', () => {
    expect(buildTags('integration && !windows && (linux || e2e) && go1.22')).toEqual([
      'integration',
      'e2e',
    ])
    expect(goWorkSummary('go 1.23\nuse ./one\n')).toBe('go.work, go 1.23, use: ./one')
    expect(includeName({ project: 'shapes/ci', file: 'go.yml' })).toBe('shapes/ci:go.yml')
    expect(includeName({ template: 'Jobs/SAST.gitlab-ci.yml' })).toBe('Jobs/SAST.gitlab-ci.yml')
    expect(
      golangciSummary('.golangci.toml', '[linters]\ndisable-all = true\nenable = ["govet"]\n'),
    ).toBe('default none; linters: govet')
    expect(
      golangciSummary('.golangci.json', '{"linters":{"enable-all":true,"disable":["lll"]}}'),
    ).toBe('default all; disabled: lll')
    expect(
      keyTargetsFirst([
        ['docker', ''],
        ['build', 'go build'],
        ['run', ''],
      ]),
    ).toEqual([
      ['build', 'go build'],
      ['run', ''],
      ['docker', ''],
    ])
  })
})

describe('collectTesting', () => {
  test('reads the test setup, commands, a test head and coverage by folder', async () => {
    const items = await collectTesting(dir, files, {
      tools: ['go test -coverprofile'],
      languages: ['go'],
      summary: { lines: { covered: 40, total: 50 } },
      files: [
        { file: 'internal/widget/widget.go', lines: { covered: 30, total: 32 } },
        { file: 'cmd/widgets/main.go', lines: { covered: 10, total: 18 } },
      ],
    })
    expect(items.map((item) => item.id)).toEqual([
      'test-setup',
      'test-scripts',
      'test-head:internal/widget/widget_test.go',
      'coverage',
    ])
    expect(textOf(items, 'test-setup')).toContain('go: layout colocated, file name {name}_test.go')
    expect(textOf(items, 'test-scripts')).toContain('make test: go test ./...')
    expect(textOf(items, 'test-head:internal/widget/widget_test.go')).toStartWith('package widget')
    expect(textOf(items, 'coverage')).toBe(
      'line coverage 80-90% of under 100 lines (go test -coverprofile)\n  internal/widget: 90-100% of under 100 lines\n  cmd/widgets: 50-60% of under 100 lines',
    )
  })

  test('is empty for a project without tests', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'guide-empty-'))
    try {
      expect(await collectTesting(empty, [])).toEqual([])
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('collectTestIds', () => {
  test('summarizes attributes, naming and tagged elements of a catalog', () => {
    const items = collectTestIds({
      attributes: ['data-testid'],
      components: [
        {
          name: 'ShapeForm',
          file: 'src/ShapeForm.tsx',
          source: 'jsx',
          total: 3,
          elements: [
            { line: 3, tag: 'button', attributes: [{ name: 'data-testid', value: 'shape-save' }] },
            { line: 4, tag: 'input', attributes: [{ name: 'data-testid', value: 'shape-name' }] },
            {
              line: 5,
              tag: 'li',
              attributes: [{ name: 'data-testid', value: 'row.id', dynamic: true }],
            },
          ],
        },
      ],
    })
    expect(items).toEqual([
      {
        id: 'testids-attributes',
        label: 'Test attributes in use',
        text: 'configured attributes: data-testid\ndata-testid: 3 elements in 1 components',
      },
      {
        id: 'testids-naming',
        label: 'Naming of literal values',
        text: 'kebab-case: 100% of 2 values, e.g. shape-name, shape-save\n33% of tagged elements use a bound value',
      },
      {
        id: 'testids-elements',
        label: 'Elements that carry test attributes',
        text: 'button (1), input (1), li (1)',
      },
    ])
  })

  test('is empty without a catalog', () => {
    expect(collectTestIds(undefined)).toEqual([])
    expect(collectTestIds({ attributes: ['data-testid'], components: [] })).toEqual([])
  })
})

test('commitsText renders inferred rules without examples or counts', () => {
  const conventions: CommitConventions = {
    repo: 'work:shapes/api',
    commit: {
      rules: {
        conventional: true,
        types: ['feat', 'fix'],
        ticket: { pattern: 'ABC-\\d+', required: true, placement: 'scope' },
        template: '<type>(<TICKET>): <subject>',
      },
      sources: {
        conventional: 'history',
        types: 'commitlint',
        ticket: 'history',
        template: 'history',
      },
      patterns: [],
      examples: ['feat(ABC-1): add circles'],
    },
    branch: {
      rules: { prefixes: ['feature'] },
      sources: { prefixes: 'history' },
      patterns: [],
      examples: [],
    },
    consulted: [],
  }
  expect(commitsText(conventions)).toBe(
    [
      '- Write commit titles as `<type>(<TICKET>): <subject>` (Conventional Commits). _(recent history)_',
      '- Use the commit types `feat`, `fix`. _(commitlint)_',
      '- Put a ticket key matching `ABC-\\d+` in every title (scope). _(recent history)_',
      '- Start branch names with `feature/`. _(recent history)_',
    ].join('\n'),
  )
  expect(
    commitsText({
      ...conventions,
      commit: { ...conventions.commit, rules: {}, sources: {} },
      branch: { ...conventions.branch, rules: {} },
    }),
  ).toBe('')
})

test('makeTargets reads targets with the first recipe line that is not an echo', () => {
  expect(
    makeTargets('.PHONY: a\nbuild:\n\t@echo building\n\tgo build\nVAR := 1\ncheck: build\n'),
  ).toEqual([
    ['build', 'go build'],
    ['check', ''],
  ])
})

test('approx rounds large counts to two significant digits', () => {
  expect([approx(7), approx(99), approx(123), approx(4567), approx(12_345)]).toEqual([
    '7',
    '99',
    '~120',
    '~4.6k',
    '~12k',
  ])
})

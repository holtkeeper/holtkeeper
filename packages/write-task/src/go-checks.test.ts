import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { detectGoChecks, goWorkUses, makeTargetKind } from './go-checks.ts'
import { agentCommands, checksEnv, detectChecks, formatGoFiles, runChecks } from './workspace.ts'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

const project = async (files: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'write-task-go-'))
  dirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await mkdir(dirname(join(dir, name)), { recursive: true })
      await writeFile(join(dir, name), content)
    }),
  )
  return dir
}

const gomod = (module: string) => `module ${module}\n\ngo 1.23\n`
const commands = (checks: { command: string }[]) => checks.map((check) => check.command)

describe('detectGoChecks', () => {
  test('a single module gets gofmt on changed files, vet and test with Go flags', async () => {
    const dir = await project({ 'go.mod': gomod('example.com/acme/widgets') })
    const { checks, notes } = await detectGoChecks(dir)
    expect(commands(checks)).toEqual(['gofmt -l', 'go vet ./...', 'go test ./...'])
    expect(checks[0]?.changedGoFiles).toBe(true)
    expect(checksEnv(checks)).toEqual({ GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod' })
    expect(notes).toEqual([])
    expect(await detectGoChecks(await project({ 'package.json': '{}' }))).toEqual({
      checks: [],
      notes: [],
    })
  })

  test('nested modules run with go -C, a go.work runs once without -mod=mod', async () => {
    const nested = await project({
      'go.mod': gomod('example.com/acme/widgets'),
      'tools/go.mod': gomod('example.com/acme/widgets/tools'),
      'vendor/x/go.mod': gomod('example.com/vendored'),
    })
    expect(commands((await detectGoChecks(nested, { tests: false })).checks)).toEqual([
      'gofmt -l',
      'go vet ./...',
      'go -C tools vet ./...',
    ])
    const work = await project({
      'go.work': 'go 1.23\n\nuse (\n\t./shapes // main\n\t./gears\n\t./missing\n)\n',
      'shapes/go.mod': gomod('example.com/acme/shapes'),
      'gears/go.mod': gomod('example.com/acme/gears'),
    })
    const { checks } = await detectGoChecks(work)
    expect(commands(checks)).toEqual([
      'gofmt -l',
      'go vet ./shapes/... ./gears/...',
      'go test ./shapes/... ./gears/...',
    ])
    expect(checksEnv(checks)).toEqual({ GOTOOLCHAIN: 'local' })
    expect(goWorkUses('use ./one\nuse (\n  "./two"\n  .\n)\n')).toEqual(['one', 'two', '.'])
  })

  test('go.work use paths keep quoted spaces and ignore trailing comments', () => {
    expect(
      goWorkUses(
        'use (\n\t"./b c" // spaced\n\t`./raw dir`\n\t./plain// note\n) // end\nuse "./d\\te"\n',
      ),
    ).toEqual(['b c', 'raw dir', 'plain', 'd\te'])
  })

  test('a module that vendors keeps the default -mod=vendor', async () => {
    const dir = await project({
      'go.mod': gomod('example.com/acme/widgets'),
      'vendor/modules.txt': '# example.com/acme/gears v1.0.0\n',
    })
    const { checks } = await detectGoChecks(dir)
    expect(commands(checks)).toEqual(['gofmt -l', 'go vet ./...', 'go test ./...'])
    expect(checksEnv(checks)).toEqual({ GOTOOLCHAIN: 'local' })
  })

  test('lints through the Makefile lint target, else golangci-lint when mise provides it', async () => {
    const make = await project({
      'go.mod': gomod('example.com/acme/widgets'),
      '.golangci.yml': 'version: "2"\n',
      Makefile: '.PHONY: lint\nlint:\n\tgolangci-lint run ./...\n',
    })
    expect(commands((await detectGoChecks(make)).checks).at(-1)).toBe('make lint')

    const mise = await project({
      'go.mod': gomod('example.com/acme/widgets'),
      '.golangci.yaml': 'linters: {}\n',
      'mise.toml': '[tools]\ngo = "1.23"\ngolangci-lint = "2.1"\n',
    })
    expect(commands((await detectGoChecks(mise)).checks).at(-1)).toBe('golangci-lint run')

    const bare = await project({
      'go.mod': gomod('example.com/acme/widgets'),
      '.golangci.toml': '',
    })
    const skipped = await detectGoChecks(bare)
    expect(commands(skipped.checks)).not.toContain('golangci-lint run')
    expect(skipped.notes[0]).toContain('skipped golangci-lint: .golangci.toml')
  })

  test('a lint target that runs a container is skipped with a note', async () => {
    const dir = await project({
      'go.mod': gomod('example.com/acme/widgets'),
      '.golangci.yml': '',
      Makefile:
        'LINTER = docker run --rm -v $(PWD):/src golangci/golangci-lint\n\nlint:\n\t$(LINTER) golangci-lint run\n',
    })
    const lines: string[] = []
    const checks = await detectChecks(dir, undefined, { log: (line) => lines.push(line) })
    expect(commands(checks)).toEqual(['gofmt -l', 'go vet ./...', 'go test ./...'])
    expect(lines).toEqual([
      'skipped `make lint`: it runs a container, which write tasks do not start',
      expect.stringContaining('skipped golangci-lint'),
    ])
  })
})

describe('makeTargetKind', () => {
  test('reads recipes, prerequisites and the variables they use', () => {
    const makefile = [
      'GO ?= go',
      'IMAGE := podman run gearbox',
      '.PHONY: lint vet image-lint',
      'lint: vet',
      '\t$(GO) run example.com/acme/linter@v1.2.0 ./...',
      'vet:',
      '\t${GO} vet ./...',
      'image-lint: ; $(IMAGE) lint',
      'boxed: image-lint',
    ].join('\n')
    expect(makeTargetKind(makefile, 'lint')).toBe('run')
    expect(makeTargetKind(makefile, 'image-lint')).toBe('container')
    expect(makeTargetKind(makefile, 'boxed')).toBe('container')
    expect(makeTargetKind(makefile, 'test')).toBe('missing')
    expect(makeTargetKind('lint := yes\n', 'lint')).toBe('missing')
  })
})

describe('running Go checks', () => {
  const status = ' M main.go\0?? pkg/new.go\0 D old.go\0 M README.md\0?? testdata/bad.go\0'

  test('gofmt runs over the changed Go files and fails when it lists any', async () => {
    const { runner, calls } = createFakeRunner(([binary]) => {
      if (binary === 'git') return { stdout: status }
      if (binary === 'gofmt') return { stdout: 'pkg/new.go\n' }
      return undefined
    })
    const checks = [
      { name: 'gofmt', command: 'gofmt -l', changedGoFiles: true },
      { name: 'go vet', command: 'go vet ./...', env: { GOTOOLCHAIN: 'local' } },
    ]
    const results = await runChecks('/repo', runner, checks, {
      env: { HTTPS_PROXY: 'http://proxy.test' },
      log: () => {},
    })
    expect(results.map((result) => [result.command, result.ok])).toEqual([
      ['gofmt -l main.go pkg/new.go', false],
      ['go vet ./...', true],
    ])
    expect(results[0]?.output).toContain('pkg/new.go')
    expect(calls.find((call) => call.command[0] === 'gofmt')?.command).toEqual([
      'gofmt',
      '-l',
      'main.go',
      'pkg/new.go',
    ])
    expect(calls.at(-1)?.options.env).toEqual({
      HTTPS_PROXY: 'http://proxy.test',
      GOTOOLCHAIN: 'local',
      CI: '1',
    })
    expect(agentCommands(checks)).toContain('gofmt -w')
  })

  test('gofmt passes without changed Go files; formatGoFiles rewrites the changed ones', async () => {
    const quiet = createFakeRunner(() => ({ stdout: ' M README.md\0' }))
    const [result] = await runChecks(
      '/repo',
      quiet.runner,
      [{ name: 'gofmt', command: 'gofmt -l', changedGoFiles: true }],
      { log: () => {} },
    )
    expect(result).toMatchObject({ ok: true, output: 'no changed Go files' })

    const { runner, calls } = createFakeRunner(([binary]) =>
      binary === 'git' ? { stdout: status } : undefined,
    )
    await formatGoFiles('/repo', runner, [{ name: 'go vet', command: 'go vet ./...' }], {
      log: () => {},
    })
    expect(calls).toEqual([])
    await formatGoFiles(
      '/repo',
      runner,
      [{ name: 'gofmt', command: 'gofmt -l', changedGoFiles: true }],
      {
        log: () => {},
      },
    )
    expect(calls.at(-1)?.command).toEqual(['gofmt', '-w', 'main.go', 'pkg/new.go'])
  })
})

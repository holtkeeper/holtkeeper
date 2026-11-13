import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { goApi, goModuleApi } from './api.ts'

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, new TextEncoder().encode(text)]))

const lib = `// Package lib does useful things. More text.
package lib

import (
	"errors"
	"io"
)

// Version is the library version.
const Version = "1.2.0"

// Weekday is a day.
type Weekday int

// Days of the week.
const (
	// Sunday starts the week.
	Sunday Weekday = iota
	Monday
	tuesday
)

var (
	// ErrClosed is returned after Close.
	ErrClosed = errors.New("closed")
	DefaultTimeout, retries = 30, 3
	// Table is long.
	Table = map[string]int{
		"a": 1,
	}
)

// Client talks to the server.
//
// Deprecated: use NewClient.
type Client struct {
	// Name is shown.
	Name string \`json:"name"\`
	mu   chan struct{}
	io.Reader
	Options struct {
		Debug bool
	}
}

// Doer does.
type Doer interface {
	Do(r *Request) (*Response, error)
	private()
}

type Request struct{}
type Response struct{}

type Set[T comparable] map[T]struct{}

// NewClient makes a client.
func NewClient(name string, opts ...func(*Client)) *Client {
	if name == "}" {
		return nil
	}
	return &Client{Name: name}
}

// Do sends a request
// across lines.
func (c *Client) Do(
	r *Request,
	timeout int,
) (*Response, error) {
	return nil, nil
}

func (c *Client) close() {}

func (s Set[T]) Has(v T) bool { _, ok := s[v]; return ok }

func helper() struct{ A int } { return struct{ A int }{} }

/* Raw is documented with a block. */
func Raw() string {
	return \`
func Fake() {}
\`
}
`

describe('goApi', () => {
  test('lists exported declarations with docs and deprecations', () => {
    const [pkg, ...rest] = goApi(
      files({
        'go.mod': 'module example.com/lib/v2\n\ngo 1.22\n',
        'lib.go': lib,
        'lib_test.go': 'package lib\nfunc TestX() {}',
      }),
      { version: 'v2.0.0' },
    )
    expect(rest).toEqual([])
    expect(pkg?.name).toBe('example.com/lib/v2')
    expect(pkg?.dir).toBe('.')
    expect(pkg?.version).toBe('v2.0.0')
    expect(pkg?.description).toBe('Package lib does useful things.')
    const symbols = pkg?.entries[0]?.symbols ?? []
    const byName = Object.fromEntries(symbols.map((symbol) => [symbol.name, symbol]))
    expect(symbols.map((symbol) => symbol.name)).toEqual([
      'Version',
      'Weekday',
      'Sunday',
      'Monday',
      'ErrClosed',
      'DefaultTimeout',
      'Table',
      'Client',
      'Doer',
      'Request',
      'Response',
      'Set',
      'NewClient',
      'Client.Do',
      'Set.Has',
      'Raw',
    ])
    expect(byName.Version).toMatchObject({
      kind: 'variable',
      signature: 'const Version = "1.2.0"',
      doc: 'Version is the library version.',
      file: 'lib.go',
      line: 10,
    })
    expect(byName.Sunday?.signature).toBe('const Sunday Weekday = iota')
    expect(byName.Sunday?.doc).toBe('Sunday starts the week.')
    expect(byName.Monday?.signature).toBe('const Monday Weekday')
    expect(byName.Monday?.doc).toBe('Days of the week.')
    expect(byName.DefaultTimeout?.signature).toBe('var DefaultTimeout, retries = 30, 3')
    expect(byName.Table?.signature).toBe('var Table = …')
    expect(byName.Client).toMatchObject({
      kind: 'type',
      deprecated: 'use NewClient.',
      signature: [
        'type Client struct {',
        '\tName string `json:"name"`',
        '\tio.Reader',
        '\tOptions struct {',
        '\t\tDebug bool',
        '\t}',
        '\t// contains filtered or unexported fields',
        '}',
      ].join('\n'),
    })
    expect(byName.Doer?.kind).toBe('interface')
    expect(byName.Set?.signature).toBe('type Set[T comparable] map[T]struct{}')
    expect(byName.NewClient).toMatchObject({
      kind: 'function',
      signature: 'func NewClient(name string, opts ...func(*Client)) *Client',
    })
    expect(byName['Client.Do']).toMatchObject({
      signature: 'func (c *Client) Do(r *Request, timeout int) (*Response, error)',
      doc: 'Do sends a request\nacross lines.',
    })
    expect(byName['Set.Has']?.signature).toBe('func (s Set[T]) Has(v T) bool')
    expect(byName.Raw?.doc).toBe('Raw is documented with a block.')
  })

  test('one package per importable directory', () => {
    const packages = goApi(
      files({
        'go.mod': 'module example.com/m',
        'doc.go': '// Package m is the root.\npackage m',
        'a/a.go': 'package a\n\nfunc A() {}\n',
        'a/a_linux.go': 'package a\n\n// A on Linux.\nfunc A() {}\n',
        'internal/x/x.go': 'package x\n\nfunc X() {}\n',
        'cmd/tool/main.go': 'package main\n\nfunc Run() {}\n',
        'gen.go': '//go:build ignore\n\npackage main\n',
        'skip/skip.go': '//go:build ignore\n\npackage skip\n\nfunc S() {}\n',
      }),
    )
    expect(packages.map((pkg) => [pkg.name, pkg.dir])).toEqual([
      ['example.com/m', '.'],
      ['example.com/m/a', 'a'],
    ])
    expect(packages[0]?.description).toBe('Package m is the root.')
    const symbol = packages[1]?.entries[0]?.symbols[0]
    expect(symbol?.file).toBe('a/a_linux.go')
    expect(symbol?.doc).toBe('A on Linux.')
  })

  test('caps symbols per package', () => {
    const [pkg] = goApi(files({ 'x.go': 'package x\n\nfunc A() {}\nfunc B() {}\nfunc C() {}\n' }), {
      module: 'example.com/x',
      maxSymbols: 2,
    })
    expect(pkg?.entries[0]?.symbols.map((symbol) => symbol.name)).toEqual(['A', 'B'])
    expect(pkg?.entries[0]?.truncated).toBe(1)
  })
})

describe('goModuleApi', () => {
  const service = files({
    'go.mod': 'module gitlab.example/shapes/svc\n',
    'cmd/server/main.go': 'package main\n\nfunc main() {}\n',
    'cmd/worker/main.go': 'package main\n\nfunc main() {}\n',
    'internal/store/store.go': '// Package store keeps shapes.\npackage store\n\nfunc Open() {}\n',
    'internal/store/store_test.go': 'package store\n\nfunc TestOpen() {}\n',
    'internal/api/v1/api.go': 'package v1\n\ntype Handler struct{}\n',
    'pkg/geom/geom.go': 'package geom\n\nfunc Area() float64 { return 0 }\n',
    'onlytests/x_test.go': 'package onlytests\n',
    'tools/go.mod': 'module gitlab.example/shapes/svc/tools\n',
    'tools/gen/gen.go': 'package gen\n\nfunc Gen() {}\n',
  })

  test('counts main and internal packages and lists only importable ones by default', () => {
    const api = goModuleApi(service)
    expect(api.module).toBe('gitlab.example/shapes/svc')
    expect(api.mainPackages).toBe(2)
    expect(api.internalPackages).toBe(2)
    expect(api.packages.map((pkg) => [pkg.name, pkg.private])).toEqual([
      ['gitlab.example/shapes/svc/pkg/geom', false],
    ])
    expect(api.packages[0]).toMatchObject({ ecosystem: 'Go', module: 'gitlab.example/shapes/svc' })
  })

  test('lists internal packages as private with includeInternal', () => {
    const api = goModuleApi(service, { includeInternal: true, version: 'v1.4.0' })
    expect(api.internalPackages).toBe(2)
    expect(api.packages.map((pkg) => [pkg.name, pkg.dir, pkg.private])).toEqual([
      ['gitlab.example/shapes/svc/internal/api/v1', 'internal/api/v1', true],
      ['gitlab.example/shapes/svc/internal/store', 'internal/store', true],
      ['gitlab.example/shapes/svc/pkg/geom', 'pkg/geom', false],
    ])
    const store = api.packages[1]
    expect(store?.description).toBe('Package store keeps shapes.')
    expect(store?.version).toBe('v1.4.0')
    expect(store?.entries[0]?.symbols.map((symbol) => symbol.name)).toEqual(['Open'])
  })

  test('goApi stays importable-only', () => {
    expect(goApi(service).map((pkg) => pkg.name)).toEqual(['gitlab.example/shapes/svc/pkg/geom'])
  })

  test('a service with only main and internal packages has no importable packages', () => {
    const api = goModuleApi(
      files({
        'go.mod': 'module example.com/acme/orders',
        'main.go': 'package main\n\nfunc main() {}\n',
        'internal/queue/queue.go': 'package queue\n\nfunc Push() {}\n',
      }),
    )
    expect(api).toMatchObject({ packages: [], mainPackages: 1, internalPackages: 1 })
  })
})

test.skipIf(!Bun.which('go'))('agrees with go doc on top-level names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goapi-'))
  try {
    await writeFile(join(dir, 'go.mod'), 'module example.com/lib\n\ngo 1.22\n')
    await writeFile(join(dir, 'lib.go'), lib)
    const run = Bun.spawnSync(['go', 'doc', '-short', '.'], {
      cwd: dir,
      env: { ...process.env, GOFLAGS: '-mod=mod' },
    })
    const names = new Set(
      new TextDecoder()
        .decode(run.stdout)
        .split('\n')
        .map(
          (line) =>
            /^(?:func|type|const|var)\s+(?:\([^)]*\)\s*)?([\p{L}_][\p{L}\p{N}_]*)/u.exec(
              line.trim(),
            )?.[1],
        )
        .filter((name) => name !== undefined),
    )
    const [pkg] = goApi(files({ 'go.mod': 'module example.com/lib', 'lib.go': lib }))
    const ours = new Set(
      (pkg?.entries[0]?.symbols ?? [])
        .filter((symbol) => !symbol.name.includes('.'))
        .map((symbol) => symbol.name),
    )
    expect(names.size).toBeGreaterThan(8)
    for (const name of names) expect(ours.has(name)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

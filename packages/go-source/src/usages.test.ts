import { describe, expect, test } from 'bun:test'

import { defaultPackageName, parseGoImports, scanGoUsages } from './usages.ts'

const sitesOf = (source: string, names?: ReadonlyMap<string, string>) =>
  scanGoUsages(source, names).sites.map(({ importPath, export: name, member, kind, props }) => ({
    importPath,
    export: name,
    kind,
    ...(member ? { member } : {}),
    ...(props ? { props } : {}),
  }))

const withImports = (body: string) =>
  `package demo\n\nimport (\n\t"example.com/acme/gears"\n)\n\n${body}\n`

const kindsOf = (body: string) =>
  sitesOf(withImports(body))
    .filter((site) => site.kind !== 'import')
    .map((site) => `${site.export}:${site.kind}${site.member ? `:${site.member}` : ''}`)

describe('parseGoImports', () => {
  test('reads single, grouped, aliased, blank and dot imports with positions', () => {
    const source = [
      'package demo',
      '',
      'import "fmt"',
      'import g "example.com/acme/gears/v2"',
      '',
      'import (',
      '\t"context" // ctx',
      '\t_ "example.com/acme/drivers/sqlish"',
      '\t. "example.com/acme/dsl"',
      '\tgeom "gitlab.example/shapes/libs/geom"',
      '\t"gopkg.in/acme/yaml.v3"',
      '\t"example.com/acme/go-widgets"',
      ')',
      '',
      'func main() {}',
    ].join('\n')
    const imports = parseGoImports(source)
    expect(imports.map(({ path, alias, name }) => ({ path, alias, name }))).toEqual([
      { path: 'fmt', alias: undefined, name: 'fmt' },
      { path: 'example.com/acme/gears/v2', alias: 'g', name: 'g' },
      { path: 'context', alias: undefined, name: 'context' },
      { path: 'example.com/acme/drivers/sqlish', alias: '_', name: undefined },
      { path: 'example.com/acme/dsl', alias: '.', name: undefined },
      { path: 'gitlab.example/shapes/libs/geom', alias: 'geom', name: 'geom' },
      { path: 'gopkg.in/acme/yaml.v3', alias: undefined, name: 'yaml' },
      { path: 'example.com/acme/go-widgets', alias: undefined, name: 'widgets' },
    ])
    expect(imports[1]).toMatchObject({
      line: 4,
      column: 10,
      offset: source.indexOf('"example.com/acme/gears/v2"'),
    })
    expect(imports[2]).toMatchObject({ line: 7, column: 2 })
  })

  test('ignores import-like text after the declarations', () => {
    expect(
      parseGoImports('package demo\n\nfunc f() {\n\tx := "import \\"fmt\\""\n\t_ = x\n}\n'),
    ).toEqual([])
  })
})

test('defaultPackageName guesses from the import path', () => {
  expect(defaultPackageName('example.com/acme/gears/v2')).toBe('gears')
  expect(defaultPackageName('gopkg.in/acme/yaml.v3')).toBe('yaml')
  expect(defaultPackageName('example.com/acme/go-widgets')).toBe('widgets')
  expect(defaultPackageName('example.com/acme/widgets-go')).toBe('widgets')
  expect(defaultPackageName('example.com/acme/shape-kit')).toBe('shape_kit')
})

describe('scanGoUsages kinds', () => {
  test('calls, including generic calls and conversions', () => {
    expect(
      kindsOf(
        'func f() {\n\tgears.Spin(1)\n\t_ = gears.Map[int, string](nil)\n\t_ = gears.Ratio(2)\n}',
      ),
    ).toEqual(['Spin:call', 'Map:call', 'Ratio:call'])
  })

  test('composite literals become new with their keys as props', () => {
    const sites = sitesOf(
      withImports(
        'func f() {\n\ta := gears.Config{Teeth: 12, Pitch: gears.Fine}\n\tb := &gears.Options{\n\t\tName: "x",\n\t\tInner: Inner{Deep: 1},\n\t}\n\tc := gears.Set[int]{}\n\t_, _, _ = a, b, c\n}',
      ),
    ).filter((site) => site.kind !== 'import')
    expect(sites).toEqual([
      {
        importPath: 'example.com/acme/gears',
        export: 'Config',
        kind: 'new',
        props: ['Teeth', 'Pitch'],
      },
      { importPath: 'example.com/acme/gears', export: 'Fine', kind: 'reference' },
      {
        importPath: 'example.com/acme/gears',
        export: 'Options',
        kind: 'new',
        props: ['Name', 'Inner'],
      },
      { importPath: 'example.com/acme/gears', export: 'Set', kind: 'new' },
    ])
  })

  test('type positions', () => {
    expect(
      kindsOf(
        [
          'var global gears.Wheel',
          'type Box struct {',
          '\tW  gears.Wheel `json:"w"`',
          '\tWs []*gears.Wheel',
          '\tM  map[string]gears.Axle',
          '\tC  chan gears.Tick',
          '\tR  <-chan gears.Tock',
          '\tS  chan<- gears.Beat',
          '\tA  [4]gears.Cog',
          '}',
          'func New(w gears.Wheel, opts ...gears.Option) (*gears.Machine, error) {',
          '\treturn nil, nil',
          '}',
          'func Plain(gears.Unnamed, int) gears.Result {',
          '\tvar x gears.Local',
          '\t_ = x',
          '\treturn gears.Result{}',
          '}',
          'func Gen[T gears.Constraint]() {}',
          'type Doer interface {',
          '\tDo(in gears.In) gears.Out',
          '}',
          'func g(v any) {',
          '\t_ = v.(gears.Asserted)',
          '\t_ = (*gears.Ptr)(nil)',
          '\tswitch v.(type) {',
          '\tcase gears.First, gears.Second:',
          '\t}',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      'Wheel:type',
      'Wheel:type',
      'Wheel:type',
      'Axle:type',
      'Tick:type',
      'Tock:type',
      'Beat:type',
      'Cog:type',
      'Wheel:type',
      'Option:type',
      'Machine:type',
      'Unnamed:type',
      'Result:type',
      'Local:type',
      'Result:new',
      'Constraint:type',
      'In:type',
      'Out:type',
      'Asserted:type',
      'Ptr:type',
      'First:type',
      'Second:type',
    ])
  })

  test('embedding becomes extends', () => {
    expect(
      kindsOf(
        'type Box struct {\n\tgears.Base\n\t*gears.Mixin `json:"-"`\n\tName string\n}\ntype Doer interface {\n\tgears.Spinner\n\tDo()\n}',
      ),
    ).toEqual(['Base:extends', 'Mixin:extends', 'Spinner:extends'])
  })

  test('one-line embedding becomes extends, a named field stays type', () => {
    expect(
      kindsOf(
        'type Box struct{ gears.Base }\ntype Pair struct{ *gears.Mixin; n int }\ntype Doer interface{ gears.Spinner }\ntype Rim struct{ hub gears.Hub }',
      ),
    ).toEqual(['Base:extends', 'Mixin:extends', 'Spinner:extends', 'Hub:type'])
  })

  test('map keys, type arguments, new and make are type positions', () => {
    expect(
      kindsOf(
        [
          'func f() {',
          '	var m map[gears.Key]int',
          '	var b Box[gears.Wheel]',
          '	var p Pair[int, gears.Axle]',
          '	w := new(gears.Wheel)',
          '	c := make(gears.Chain, 3)',
          '	_, _, _, _, _ = m, b, p, w, c',
          '}',
        ].join('\n'),
      ),
    ).toEqual(['Key:type', 'Wheel:type', 'Axle:type', 'Wheel:type', 'Chain:type'])
  })

  test('type aliases become reexport, definitions stay type', () => {
    expect(
      kindsOf(
        'type Wheel = gears.Wheel\ntype (\n\tAxle = gears.Axle\n\tTick gears.Tick\n)\ntype Mine gears.Wheel\ntype List[T any] = gears.List[T]',
      ),
    ).toEqual(['Wheel:reexport', 'Axle:reexport', 'Tick:type', 'Wheel:type', 'List:reexport'])
  })

  test('selectors on a package-level value or a type become member', () => {
    expect(
      kindsOf(
        'func f() {\n\tgears.Default.Spin()\n\t_ = gears.Default.Config.Teeth\n\tm := gears.Wheel.Turn\n\t_ = m\n}',
      ),
    ).toEqual(['Default:member:Spin', 'Default:member:Config.Teeth', 'Wheel:member:Turn'])
  })

  test('everything else is a reference', () => {
    expect(
      kindsOf(
        [
          'var ok = gears.Enabled',
          'func f(err error) bool {',
          '\tif err == gears.ErrJammed {',
          '\t\treturn true',
          '\t}',
          '\tfor range gears.All {',
          '\t}',
          '\tswitch gears.Mode {',
          '\tcase gears.Fast:',
          '\t}',
          '\tg(gears.Handler, 1)',
          '\tx := <-gears.Done',
          '\t_ = x',
          '\treturn errors.Is(err, gears.ErrSlipped)',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      'Enabled:reference',
      'ErrJammed:reference',
      'All:reference',
      'Mode:reference',
      'Fast:reference',
      'Handler:reference',
      'Done:reference',
      'ErrSlipped:reference',
    ])
  })

  test('a statement after a closing line is not a type position', () => {
    expect(
      kindsOf('func f() {\n\tg(1)\n\tgears.Count = 2\n\tvar x int\n\tgears.Total = x\n}'),
    ).toEqual(['Count:reference', 'Total:reference'])
  })
})

describe('scanGoUsages imports', () => {
  test('blank and dot imports give import sites only', () => {
    const source = [
      'package demo',
      '',
      'import (',
      '\t_ "example.com/acme/drivers/sqlish"',
      '\t. "example.com/acme/dsl"',
      ')',
      '',
      'func f() { Run(Step()) }',
    ].join('\n')
    expect(sitesOf(source)).toEqual([
      { importPath: 'example.com/acme/drivers/sqlish', export: '*', kind: 'import' },
      { importPath: 'example.com/acme/dsl', export: '*', kind: 'import' },
    ])
  })

  test('aliases are followed and unused named imports give an import site', () => {
    const source = [
      'package demo',
      '',
      'import (',
      '\tg "example.com/acme/gears/v2"',
      '\t"gitlab.example/shapes/libs/geom"',
      ')',
      '',
      'func f() { g.Spin() }',
    ].join('\n')
    expect(sitesOf(source)).toEqual([
      { importPath: 'gitlab.example/shapes/libs/geom', export: '*', kind: 'import' },
      { importPath: 'example.com/acme/gears/v2', export: 'Spin', kind: 'call' },
    ])
  })

  test('package names given by the caller replace the guess', () => {
    const source =
      'package demo\n\nimport "example.com/acme/shape-kit"\n\nfunc f() { kit.Draw() }\n'
    expect(sitesOf(source)).toEqual([
      { importPath: 'example.com/acme/shape-kit', export: '*', kind: 'import' },
    ])
    expect(sitesOf(source, new Map([['example.com/acme/shape-kit', 'kit']]))).toEqual([
      { importPath: 'example.com/acme/shape-kit', export: 'Draw', kind: 'call' },
    ])
  })

  test('ignores strings, comments, field selectors and lower-level selectors', () => {
    expect(
      kindsOf(
        'func f(s S) {\n\t// gears.Commented()\n\t_ = "gears.InString()"\n\t_ = s.gears.Field\n\t_ = `gears.Raw`\n\t/* gears.Block */\n\tgears.Real()\n}',
      ),
    ).toEqual(['Real:call'])
  })

  test('reports positions and the package name', () => {
    const source = withImports('func f() {\n\tgears.Spin()\n}')
    const scan = scanGoUsages(source)
    expect(scan.packageName).toBe('demo')
    expect(scan.sites).toEqual([
      {
        importPath: 'example.com/acme/gears',
        export: 'Spin',
        kind: 'call',
        line: 8,
        column: 2,
        offset: source.indexOf('gears.Spin'),
      },
    ])
  })
})

import { describe, expect, test } from 'bun:test'

import { applyReplacements, type Edit } from '@holtkeeper/changes'

import {
  compareWithConvention,
  conventionChange,
  type ConventionSpec,
  conventionSpecSchema,
} from './conventions.ts'

const spec = (
  overrides: Partial<ConventionSpec> & Pick<ConventionSpec, 'path' | 'mode' | 'content'>,
): ConventionSpec => ({ create: true, ...overrides })

function apply(text: string, edits: Edit[] | undefined): string {
  const replaces = (edits ?? []).filter((edit) => edit.kind === 'replace')
  const result = applyReplacements(text, replaces)
  if ('error' in result) throw new Error(result.error)
  return result.text
}

test('the schema fills defaults and rejects empty golden content', () => {
  expect(conventionSpecSchema.parse({ path: '.nvmrc', content: '22' })).toEqual({
    path: '.nvmrc',
    mode: 'exact',
    content: '22',
    create: true,
  })
  expect(conventionSpecSchema.safeParse({ path: '.nvmrc', content: '' }).success).toBe(false)
})

describe('exact', () => {
  const nvmrc = spec({ path: '.nvmrc', mode: 'exact', content: '22\n' })

  test('ignores line endings and trailing blank lines', () => {
    expect(compareWithConvention(nvmrc, '22\r\n\n').status).toBe('matches')
  })

  test('replaces the whole file', () => {
    const result = compareWithConvention(nvmrc, '18\n')
    expect(result.status).toBe('drifts')
    expect(result.problems).toEqual(['1 of 1 lines differ from the golden file'])
    expect(apply('18\n', result.edits)).toBe('22\n')
  })

  test('creates missing files unless told not to', () => {
    expect(compareWithConvention(nvmrc, undefined).edits).toEqual([
      { kind: 'create', file: '.nvmrc', newText: '22\n' },
    ])
    expect(compareWithConvention({ ...nvmrc, create: false }, undefined)).toEqual({
      status: 'missing',
      problems: ['file is missing'],
    })
  })
})

const pkg = (content: string) => spec({ path: 'package.json', mode: 'json-subset', content })

describe('json-subset', () => {
  test('compares only keys the golden content defines', () => {
    const actual = JSON.stringify({ name: 'x', engines: { node: '>=22' }, private: true }, null, 2)
    expect(compareWithConvention(pkg('{"engines":{"node":">=22"}}'), actual).status).toBe('matches')
  })

  test('replaces changed values and appends missing keys in place', () => {
    const actual = '{\n  "name": "widget",\n  "engines": {\n    "node": ">=18"\n  }\n}\n'
    const golden = pkg('{"engines":{"node":">=22","npm":">=10"},"type":"module"}')
    const result = compareWithConvention(golden, actual)
    expect(result.status).toBe('drifts')
    expect(result.problems).toEqual([
      'engines.node: expected ">=22", found ">=18"',
      'engines.npm: missing, expected ">=10"',
      'type: missing, expected "module"',
    ])
    const fixed = apply(actual, result.edits)
    expect(fixed).toBe(
      '{\n  "name": "widget",\n  "engines": {\n    "node": ">=22",\n    "npm": ">=10"\n  },\n  "type": "module"\n}\n',
    )
    expect(compareWithConvention(golden, fixed).status).toBe('matches')
  })

  test('keeps comments and trailing commas of tsconfig files', () => {
    const tsconfig = spec({
      path: 'tsconfig.json',
      mode: 'json-subset',
      content: '{"extends":"@shapes/tsconfig","compilerOptions":{"strict":true}}',
    })
    const actual = '{\n  // shared base\n  "extends": "./old.json",\n  "compilerOptions": {},\n}\n'
    const fixed = apply(actual, compareWithConvention(tsconfig, actual).edits)
    expect(fixed).toContain('// shared base')
    expect(fixed).toContain('"extends": "@shapes/tsconfig"')
    expect(compareWithConvention(tsconfig, fixed).status).toBe('matches')
  })

  test('array items must be present, missing ones are appended', () => {
    const actual = '{\n  "extends": [\n    "a"\n  ]\n}'
    const result = compareWithConvention(pkg('{"extends":["b"]}'), actual)
    expect(apply(actual, result.edits)).toBe('{\n  "extends": [\n    "a",\n    "b"\n  ]\n}')
  })

  test('reports files and golden content that do not parse', () => {
    expect(compareWithConvention(pkg('{}'), '{ nope').status).toBe('error')
    expect(compareWithConvention(pkg('{ nope'), '{}').problems[0]).toStartWith(
      'golden content does not parse',
    )
  })
})

describe('yaml-subset', () => {
  test('appends missing include items and keys', () => {
    const actual = [
      'include:',
      '  - project: shapes/ci',
      '    file: /old.yml',
      'stages:',
      '  - test',
      'variables:',
      '  NODE_VERSION: "18"',
      '',
    ].join('\n')
    const ci = spec({
      path: '.gitlab-ci.yml',
      mode: 'yaml-subset',
      content: [
        'include:',
        '  - project: shapes/ci',
        '    file: /node.yml',
        'variables:',
        '  NODE_VERSION: "22"',
        'default:',
        '  interruptible: true',
      ].join('\n'),
    })
    const result = compareWithConvention(ci, actual)
    expect(result.status).toBe('drifts')
    const fixed = apply(actual, result.edits)
    expect(fixed).toContain('  - project: shapes/ci\n    file: /node.yml')
    expect(fixed).toContain('  NODE_VERSION: "22"')
    expect(fixed).toContain('default:\n  interruptible: true')
    expect(compareWithConvention(ci, fixed).status).toBe('matches')
  })

  test('does not guess edits for flow collections', () => {
    const ci = spec({ path: '.gitlab-ci.yml', mode: 'yaml-subset', content: 'stages:\n  - build' })
    const result = compareWithConvention(ci, 'stages: [test]\n')
    expect(result.status).toBe('drifts')
    expect(result.edits).toBeUndefined()
    expect(result.problems).toContain('cannot be fixed automatically')
  })
})

describe('lines-present', () => {
  const gitignore = spec({
    path: '.gitignore',
    mode: 'lines-present',
    content: 'node_modules\ndist\n',
  })

  test('accepts the lines in any order among others', () => {
    expect(compareWithConvention(gitignore, 'coverage\ndist\n  node_modules\n').status).toBe(
      'matches',
    )
  })

  test('appends missing lines', () => {
    const result = compareWithConvention(gitignore, 'node_modules')
    expect(result.problems).toEqual(['missing line dist'])
    expect(apply('node_modules', result.edits)).toBe('node_modules\ndist\n')
  })

  test('creates a missing file from the non-blank lines', () => {
    expect(compareWithConvention(gitignore, undefined).edits).toEqual([
      { kind: 'create', file: '.gitignore', newText: 'node_modules\ndist\n' },
    ])
  })
})

test('changes target the repository and keep stable ids', () => {
  const nvmrc = spec({ path: '.nvmrc', mode: 'exact', content: '22' })
  const repo = { forge: 'work', path: 'shapes/circle' }
  const first = conventionChange(repo, nvmrc, compareWithConvention(nvmrc, '18'))
  const second = conventionChange(repo, nvmrc, compareWithConvention(nvmrc, '18'))
  expect(first?.target).toEqual(repo)
  expect(first?.source).toBe('stack')
  expect(first?.id).toBe(second?.id ?? '')
  expect(conventionChange(repo, nvmrc, compareWithConvention(nvmrc, '22'))).toBeUndefined()
})

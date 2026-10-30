import { describe, expect, test } from 'bun:test'

import { applyReplacements, type Edit } from '@holtkeeper/changes'

import { compareWithTemplate, templateChange, type TemplateSpec } from './templates.ts'

const spec = (
  overrides: Partial<TemplateSpec> & Pick<TemplateSpec, 'path' | 'mode'>,
): TemplateSpec => ({
  create: true,
  ...overrides,
})

function apply(text: string, edits: Edit[] | undefined): string {
  const replaces = (edits ?? []).filter((edit) => edit.kind === 'replace')
  const result = applyReplacements(text, replaces)
  if ('error' in result) throw new Error(result.error)
  return result.text
}

describe('exact', () => {
  const nvmrc = spec({ path: '.nvmrc', mode: 'exact' })

  test('ignores line endings and trailing whitespace', () => {
    expect(compareWithTemplate(nvmrc, '22\n', '22\r\n\n').status).toBe('identical')
  })

  test('replaces the whole file', () => {
    const result = compareWithTemplate(nvmrc, '22\n', '18\n')
    expect(result.status).toBe('drifted')
    expect(apply('18\n', result.edits)).toBe('22\n')
  })

  test('creates missing files unless told not to', () => {
    expect(compareWithTemplate(nvmrc, '22', undefined).edits).toEqual([
      { kind: 'create', file: '.nvmrc', newText: '22\n' },
    ])
    const result = compareWithTemplate({ ...nvmrc, create: false }, '22', undefined)
    expect(result).toEqual({ status: 'missing', problems: ['file is missing'] })
  })
})

describe('json-subset', () => {
  const pkg = spec({ path: 'package.json', mode: 'json-subset' })

  test('compares only keys the template defines', () => {
    const actual = JSON.stringify({ name: 'x', engines: { node: '>=22' }, private: true }, null, 2)
    expect(compareWithTemplate(pkg, '{"engines":{"node":">=22"}}', actual).status).toBe('identical')
  })

  test('replaces changed values and appends missing keys in place', () => {
    const actual = '{\n  "name": "api",\n  "engines": {\n    "node": ">=18"\n  }\n}\n'
    const template = '{"engines":{"node":">=22","npm":">=10"},"type":"module"}'
    const result = compareWithTemplate(pkg, template, actual)
    expect(result.status).toBe('drifted')
    expect(result.problems).toEqual([
      'engines.node: expected ">=22", found ">=18"',
      'engines.npm: missing, expected ">=10"',
      'type: missing, expected "module"',
    ])
    const fixed = apply(actual, result.edits)
    expect(fixed).toBe(
      '{\n  "name": "api",\n  "engines": {\n    "node": ">=22",\n    "npm": ">=10"\n  },\n  "type": "module"\n}\n',
    )
    expect(compareWithTemplate(pkg, template, fixed).status).toBe('identical')
  })

  test('keeps comments and trailing commas of tsconfig files', () => {
    const tsconfig = spec({ path: 'tsconfig.json', mode: 'json-subset' })
    const actual = '{\n  // shared base\n  "extends": "./old.json",\n  "compilerOptions": {},\n}\n'
    const template = '{"extends":"@acme/tsconfig","compilerOptions":{"strict":true}}'
    const result = compareWithTemplate(tsconfig, template, actual)
    const fixed = apply(actual, result.edits)
    expect(fixed).toContain('// shared base')
    expect(fixed).toContain('"extends": "@acme/tsconfig"')
    expect(compareWithTemplate(tsconfig, template, fixed).status).toBe('identical')
  })

  test('array items must be present, missing ones are appended', () => {
    const actual = '{\n  "extends": [\n    "a"\n  ]\n}'
    const result = compareWithTemplate(pkg, '{"extends":["b"]}', actual)
    expect(apply(actual, result.edits)).toBe('{\n  "extends": [\n    "a",\n    "b"\n  ]\n}')
  })

  test('reports files that do not parse', () => {
    expect(compareWithTemplate(pkg, '{}', '{ nope').status).toBe('error')
  })
})

describe('yaml-subset', () => {
  const ci = spec({ path: '.gitlab-ci.yml', mode: 'yaml-subset' })

  test('appends missing include items and keys', () => {
    const actual = [
      'include:',
      '  - project: acme/ci',
      '    file: /old.yml',
      'stages:',
      '  - test',
      'variables:',
      '  NODE_VERSION: "18"',
      '',
    ].join('\n')
    const template = [
      'include:',
      '  - project: acme/ci',
      '    file: /node.yml',
      'variables:',
      '  NODE_VERSION: "22"',
      'default:',
      '  interruptible: true',
    ].join('\n')
    const result = compareWithTemplate(ci, template, actual)
    expect(result.status).toBe('drifted')
    const fixed = apply(actual, result.edits)
    expect(fixed).toContain('  - project: acme/ci\n    file: /node.yml')
    expect(fixed).toContain('  NODE_VERSION: "22"')
    expect(fixed).toContain('default:\n  interruptible: true')
    expect(compareWithTemplate(ci, template, fixed).status).toBe('identical')
  })

  test('does not guess edits for flow collections', () => {
    const result = compareWithTemplate(ci, 'stages:\n  - build', 'stages: [test]\n')
    expect(result.status).toBe('drifted')
    expect(result.edits).toBeUndefined()
    expect(result.problems).toContain('cannot be fixed automatically')
  })
})

describe('lines-present', () => {
  test('appends missing literal lines', () => {
    const gitignore = spec({ path: '.gitignore', mode: 'lines-present' })
    const result = compareWithTemplate(gitignore, 'node_modules\ndist\n', 'node_modules')
    expect(result.problems).toEqual(['missing line dist'])
    expect(apply('node_modules', result.edits)).toBe('node_modules\ndist\n')
  })

  test('replaces lines matched by a pattern', () => {
    const docker = spec({
      path: 'Dockerfile',
      mode: 'lines-present',
      lines: [{ pattern: '^FROM node:22', line: 'FROM node:22-alpine', replaces: '^FROM node:' }],
    })
    const actual = 'FROM node:18-alpine\nWORKDIR /app\n'
    const result = compareWithTemplate(docker, undefined, actual)
    expect(result.status).toBe('drifted')
    expect(apply(actual, result.edits)).toBe('FROM node:22-alpine\nWORKDIR /app\n')
    expect(compareWithTemplate(docker, undefined, 'FROM node:22.4\n').status).toBe('identical')
  })

  test('patterns without a line are reported only', () => {
    const docker = spec({
      path: 'Dockerfile',
      mode: 'lines-present',
      lines: [{ pattern: '^USER ' }],
    })
    const result = compareWithTemplate(docker, undefined, 'FROM x\n')
    expect(result.edits).toBeUndefined()
    expect(compareWithTemplate(docker, undefined, undefined).edits).toBeUndefined()
  })
})

test('changes target the repository and keep stable ids', () => {
  const nvmrc = spec({ path: '.nvmrc', mode: 'exact' })
  const repo = { forge: 'work', path: 'acme/api' }
  const first = templateChange(repo, nvmrc, compareWithTemplate(nvmrc, '22', '18'))
  const second = templateChange(repo, nvmrc, compareWithTemplate(nvmrc, '22', '18'))
  expect(first?.target).toEqual(repo)
  expect(first?.id).toBe(second?.id ?? '')
  expect(templateChange(repo, nvmrc, compareWithTemplate(nvmrc, '22', '22'))).toBeUndefined()
})

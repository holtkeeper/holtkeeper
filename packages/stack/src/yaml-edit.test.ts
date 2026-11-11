import { expect, test } from 'bun:test'

import { emitYaml, yamlScalar } from './yaml-edit.ts'

test('scalars stay plain when that reads back the same', () => {
  expect(yamlScalar('node:22-alpine')).toBe('node:22-alpine')
  expect(yamlScalar('yes')).toBe('"yes"')
  expect(yamlScalar('a: b')).toBe('"a: b"')
  expect(yamlScalar('22')).toBe('"22"')
  expect(yamlScalar(22)).toBe('22')
})

test('emits block YAML that parses back to the value', () => {
  const value = { include: [{ project: 'acme/ci', file: ['/a.yml', '/b.yml'] }], cache: {}, n: 1 }
  expect(Bun.YAML.parse(emitYaml(value, 0).join('\n'))).toEqual(value)
})

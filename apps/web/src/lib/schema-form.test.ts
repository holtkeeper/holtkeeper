import { describe, expect, test } from 'bun:test'

import {
  describeField,
  fits,
  hasForm,
  humanize,
  initialValue,
  parseNumber,
  resolve,
  stringError,
  variantIndex,
} from './schema-form.ts'

const toolchain = {
  type: 'object',
  properties: {
    tools: {
      type: 'object',
      propertyNames: { type: 'string', minLength: 1 },
      additionalProperties: { type: 'string', minLength: 1 },
    },
    image: { type: 'string', minLength: 1 },
    network: { type: 'string', enum: ['none', 'install', 'full'] },
    env: {
      type: 'object',
      propertyNames: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      additionalProperties: { type: 'string' },
    },
  },
  additionalProperties: false,
}

const limits = {
  type: 'object',
  propertyNames: { type: 'string', minLength: 1 },
  additionalProperties: {
    type: 'object',
    properties: {
      maxConcurrent: { type: 'integer', exclusiveMinimum: 0 },
      backoff: {
        type: 'object',
        properties: {
          onStatus: {
            minItems: 1,
            type: 'array',
            items: { type: 'integer', minimum: 100, maximum: 599 },
          },
        },
      },
    },
  },
}

const allowlist = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1 },
      expires: { type: 'string', format: 'date' },
      when: {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: ['string', 'number', 'boolean'] },
      },
    },
    required: ['id', 'reason'],
    additionalProperties: false,
  },
}

const rules = {
  type: 'array',
  items: {
    oneOf: [
      {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'unused' },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
          usage: { type: 'string', minLength: 1 },
        },
        required: ['kind', 'usage'],
      },
      {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'naming' },
          pattern: { type: 'string', minLength: 1 },
          roles: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        required: ['kind', 'pattern', 'roles'],
      },
    ],
  },
}

const policies = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      when: { default: {}, $ref: '#/$defs/__schema0' },
      skipAnalyzers: {
        anyOf: [
          { type: 'string', const: '*' },
          { type: 'array', items: { type: 'string', minLength: 1 } },
        ],
      },
    },
    required: ['when'],
  },
  $defs: {
    __schema0: {
      type: 'object',
      properties: {
        event: {},
        not: { $ref: '#/$defs/__schema0' },
        all: { type: 'array', items: { $ref: '#/$defs/__schema0' } },
      },
    },
  },
}

const quality = {
  type: 'object',
  properties: {
    examples: { default: 3, type: 'integer', minimum: 0 },
    coverage: { default: 'run', type: 'string', enum: ['run', 'skip'] },
  },
}

describe('describeField', () => {
  test('objects, records and enums', () => {
    const node = describeField(toolchain, toolchain)
    expect(node.kind).toBe('object')
    if (node.kind !== 'object') return
    expect(node.properties.map((p) => [p.name, describeField(p.schema, toolchain).kind])).toEqual([
      ['tools', 'record'],
      ['image', 'string'],
      ['network', 'enum'],
      ['env', 'record'],
    ])
    expect(describeField(toolchain.properties.env, toolchain)).toMatchObject({
      kind: 'record',
      key: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    })
  })

  test('records of objects and number tags', () => {
    expect(describeField(limits, limits)).toMatchObject({ kind: 'record' })
    expect(
      describeField(limits.additionalProperties.properties.backoff.properties.onStatus, limits),
    ).toEqual({ kind: 'tags', item: { kind: 'number', integer: true, minimum: 100, maximum: 599 } })
  })

  test('lists of objects and type lists', () => {
    expect(describeField(allowlist, allowlist)).toMatchObject({ kind: 'list' })
    const when = describeField(allowlist.items.properties.when, allowlist)
    expect(when.kind).toBe('record')
    if (when.kind !== 'record') return
    expect(describeField(when.value, allowlist)).toMatchObject({
      kind: 'variants',
      variants: [{ label: 'Text' }, { label: 'Number' }, { label: 'Yes / no' }],
    })
  })

  test('discriminated variants', () => {
    expect(describeField(rules.items, rules)).toMatchObject({
      kind: 'variants',
      discriminator: 'kind',
      variants: [{ label: 'unused' }, { label: 'naming' }],
    })
  })

  test('recursive references and mixed variants', () => {
    expect(describeField(policies.items.properties.when, policies)).toMatchObject({
      kind: 'object',
    })
    expect(resolve(policies.items.properties.when, policies)).toMatchObject({ default: {} })
    expect(describeField({ $ref: '#/$defs/__schema0/properties/not' }, policies)).toMatchObject({
      kind: 'object',
    })
    expect(describeField(policies.items.properties.skipAnalyzers, policies)).toMatchObject({
      kind: 'variants',
      variants: [{ label: '*' }, { label: 'List' }],
    })
    expect(describeField({}, null)).toEqual({ kind: 'any' })
  })

  test('hasForm', () => {
    expect(hasForm(quality)).toBeTrue()
    expect(hasForm({})).toBeFalse()
  })
})

describe('values', () => {
  test('initialValue fills required fields and fixed discriminators', () => {
    expect(initialValue(allowlist.items, allowlist)).toEqual({ id: '', reason: '' })
    expect(initialValue(rules.items.oneOf[1], rules)).toEqual({
      kind: 'naming',
      pattern: '',
      roles: [],
    })
    expect(initialValue(rules.items, rules)).toEqual({ kind: 'unused', usage: '' })
    expect(initialValue(quality.properties.examples, quality)).toBe(3)
    expect(initialValue(limits.additionalProperties.properties.maxConcurrent, limits)).toBe(1)
    expect(initialValue(policies.items, policies)).toEqual({ when: {} })
  })

  test('variantIndex picks the variant a value fits', () => {
    const node = describeField(rules.items, rules)
    if (node.kind !== 'variants') throw new Error(node.kind)
    expect(variantIndex(node.variants, { kind: 'naming' }, rules)).toBe(1)
    expect(variantIndex(node.variants, { kind: 'nope' }, rules)).toBe(0)
    expect(fits({ type: 'integer' }, 1.5, null)).toBeFalse()
    expect(fits(policies.items.properties.skipAnalyzers, ['a'], policies)).toBeTrue()
  })

  test('leaf validation', () => {
    expect(stringError({ minLength: 1 }, '')).toBe('Required')
    expect(stringError({ pattern: '^[a-z]+$' }, 'A')).toBe('Does not match the expected format')
    expect(stringError({ pattern: '^[a-z]+$' }, '')).toBeUndefined()
    expect(parseNumber({ integer: true }, '1.5')).toEqual({
      ok: false,
      error: 'Enter a whole number',
    })
    expect(parseNumber({ integer: false, exclusiveMinimum: 0 }, '0')).toEqual({
      ok: false,
      error: 'More than 0',
    })
    expect(parseNumber({ integer: false, maximum: 5 }, '4')).toEqual({ ok: true, value: 4 })
    expect(parseNumber({ integer: false }, '')).toEqual({ ok: false, error: 'Enter a number' })
  })

  test('humanize', () => {
    expect(humanize('maxResultLines')).toBe('Max result lines')
    expect(humanize('release-risk')).toBe('Release risk')
  })
})

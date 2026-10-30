import { describe, expect, test } from 'bun:test'

import { buildEntities } from '../merge.ts'
import type { SourceHit } from '../sources/types.ts'
import { evaluateRule, ruleSchema, sameValue } from './index.ts'

const hit = (
  key: string,
  role: string,
  extra: Partial<SourceHit['occurrence']> = {},
  attrs: Record<string, string> = {},
): SourceHit => ({
  key,
  attrs,
  occurrence: { source: role, role, repo: 'r', file: `${role}.txt`, ...extra },
})

const entities = buildEntities(
  [
    hit('used', 'definition', {}, { default: 'true' }),
    hit('used', 'usage'),
    hit('used', 'documentation', {
      repo: undefined,
      file: undefined,
      document: { provider: 'wiki', ref: '1', title: 'Flags' },
    }),
    hit('used', 'config', { environment: 'prod' }, { value: 'off' }),
    hit('used', 'config', { environment: 'dev' }, { value: 'TRUE' }),
    hit('Unused-Flag', 'definition'),
    hit('ghost', 'usage'),
    hit('stale', 'config', { environment: 'prod' }, { value: '1' }),
    hit('paper', 'documentation'),
  ],
  [],
)

const run = (config: unknown) => evaluateRule(entities, ruleSchema.parse(config), { label: 'Flag' })

describe('rules', () => {
  test('unused', () => {
    expect(
      run({ kind: 'unused' }).map((finding) => [finding.id, finding.severity, finding.message]),
    ).toEqual([
      [
        'unused:Unused-Flag',
        'warning',
        'Flag Unused-Flag is defined in r/definition.txt but never used',
      ],
    ])
  })

  test('undefined with default and narrowed roles', () => {
    expect(run({ kind: 'undefined' }).map((finding) => finding.key)).toEqual([
      'ghost',
      'paper',
      'stale',
    ])
    expect(
      run({ kind: 'undefined', roles: ['usage'], severity: 'info' }).map((finding) => [
        finding.key,
        finding.severity,
      ]),
    ).toEqual([['ghost', 'info']])
  })

  test('stale-config, undocumented, documented-missing', () => {
    expect(run({ kind: 'stale-config' }).map((finding) => finding.key)).toEqual(['stale'])
    expect(run({ kind: 'undocumented' }).map((finding) => finding.key)).toEqual(['Unused-Flag'])
    expect(run({ kind: 'documented-missing' }).map((finding) => finding.key)).toEqual(['paper'])
  })

  test('attribute-mismatch per environment', () => {
    const findings = run({
      kind: 'attribute-mismatch',
      attr: 'default',
      against: { attr: 'value' },
    })
    expect(findings.map((finding) => [finding.id, finding.environment])).toEqual([
      ['attribute-mismatch:used:prod', 'prod'],
    ])
    expect(findings[0]?.message).toBe(
      'used: default is true in definition, but value is off in r/config.txt (prod)',
    )
    expect(findings[0]?.occurrences.map((occurrence) => occurrence.role)).toEqual([
      'definition',
      'config',
    ])
    expect(
      run({
        kind: 'attribute-mismatch',
        attr: 'default',
        against: { attr: 'value' },
        environments: ['dev'],
      }),
    ).toEqual([])
  })

  test('naming on spellings, ignore and custom ids', () => {
    expect(run({ kind: 'naming', pattern: '^[a-z_]+$' }).map((finding) => finding.message)).toEqual(
      ['Flag Unused-Flag does not match ^[a-z_]+$'],
    )
    expect(run({ kind: 'naming', id: 'snake', pattern: '^[a-z_]+$', ignore: ['Unused*'] })).toEqual(
      [],
    )
    expect(run({ kind: 'unused', id: 'dead' })[0]?.id).toBe('dead:Unused-Flag')
  })

  test('sameValue is loose about spelling', () => {
    expect(sameValue('true', 'TRUE')).toBe(true)
    expect(sameValue('on', 'true')).toBe(true)
    expect(sameValue('1.0', '1')).toBe(true)
    expect(sameValue('off', 'true')).toBe(false)
    expect(sameValue('', '0')).toBe(false)
  })
})

test('buildEntities merges spellings and attributes by role precedence', () => {
  const [entity] = buildEntities(
    [
      hit('newLobby', 'usage', {}, { description: 'from code' }),
      hit('NEW_LOBBY', 'definition', {}, { description: 'from definition' }),
      hit('new_lobby', 'config', { environment: 'prod' }, { value: 'true' }),
    ],
    ['snake'],
  )
  expect(entity?.key).toBe('new_lobby')
  expect(entity?.labels).toEqual(['newLobby', 'NEW_LOBBY', 'new_lobby'])
  expect(entity?.attrs.description?.value).toBe('from definition')
  expect(entity?.attrs.description?.values?.map((value) => value.value)).toEqual([
    'from definition',
    'from code',
  ])
  expect(entity?.environments).toEqual({ prod: { value: 'true' } })
  expect(entity?.occurrences.map((occurrence) => occurrence.raw)).toEqual([
    'newLobby',
    'NEW_LOBBY',
    undefined,
  ])
})

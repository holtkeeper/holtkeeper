import { describe, expect, test } from 'bun:test'

import {
  type TrackerValue,
  newPart,
  newTracker,
  normalizeTrackers,
  partVariants,
  linkSource,
  rolesOf,
  trackerLinks,
  trackerProblems,
} from './trackers.ts'

const schema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'files' },
                role: { type: 'string', 'x-role': 'provides' },
                paths: { type: 'array', items: { type: 'string' }, minItems: 1 },
              },
              required: ['kind', 'role', 'paths'],
            },
          ],
        },
      },
      rules: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'unused' },
                definition: { type: 'array', default: ['definition'], 'x-role': 'reads' },
                usage: { type: 'array', default: ['usage'], 'x-role': 'reads' },
              },
              required: ['kind'],
            },
            {
              type: 'object',
              properties: {
                kind: { const: 'attribute-mismatch' },
                role: { type: 'string', default: 'definition', 'x-role': 'reads' },
                against: {
                  type: 'object',
                  properties: { role: { type: 'string', default: 'config', 'x-role': 'reads' } },
                },
              },
              required: ['kind'],
            },
          ],
        },
      },
      outputs: {
        type: 'array',
        items: { oneOf: [{ $ref: '#/$defs/notify' }] },
      },
    },
  },
  $defs: { notify: { type: 'object', properties: { kind: { const: 'notify' } } } },
}

const variants = {
  sources: partVariants(schema, 'sources'),
  rules: partVariants(schema, 'rules'),
  outputs: partVariants(schema, 'outputs'),
}

const tracker = (patch: Partial<TrackerValue> = {}): TrackerValue => ({
  id: 'flags',
  name: 'Flags',
  entity: { label: 'Flag', key: { normalize: [] } },
  sources: [
    { kind: 'files', role: 'definition', paths: ['flags.ts'] },
    { kind: 'files', role: 'usage', paths: ['src/**'] },
    { kind: 'files', role: 'docs', paths: ['README.md'] },
  ],
  rules: [{ kind: 'unused' }, { kind: 'attribute-mismatch', against: { role: 'staging' } }],
  outputs: [{ kind: 'notify' }],
  ...patch,
})

test('partVariants finds every kind through refs', () => {
  expect([...variants.sources.keys()]).toEqual(['files'])
  expect([...variants.rules.keys()]).toEqual(['unused', 'attribute-mismatch'])
  expect([...variants.outputs.keys()]).toEqual(['notify'])
})

test('rolesOf reads marked fields, defaults and nested objects', () => {
  expect(rolesOf({ kind: 'unused' }, variants.rules.get('unused'), schema, 'reads')).toEqual([
    'definition',
    'usage',
  ])
  expect(
    rolesOf(
      { kind: 'attribute-mismatch', role: 'definition', against: { role: 'prod' } },
      variants.rules.get('attribute-mismatch'),
      schema,
      'reads',
    ),
  ).toEqual(['definition', 'prod'])
})

test('trackerLinks connects roles and flags missing and unread ones', () => {
  expect(trackerLinks(tracker(), variants, schema)).toEqual({
    sources: [
      { id: 'files-1', kind: 'files', role: ['definition'] },
      { id: 'files-2', kind: 'files', role: ['usage'] },
      { id: 'files-3', kind: 'files', role: ['docs'] },
    ],
    rules: [
      { id: 'unused', kind: 'unused', reads: ['definition', 'usage'], missing: [] },
      {
        id: 'attribute-mismatch',
        kind: 'attribute-mismatch',
        reads: ['definition', 'staging'],
        missing: ['staging'],
      },
    ],
    outputs: [{ id: 'notify-1', kind: 'notify' }],
    unread: ['files-3'],
  })
})

test('linkSource gives the source a role the rule still lacks', () => {
  const linked = linkSource(tracker(), variants, schema, 2, 1)
  expect(linked?.role).toBe('staging')
  expect(linked?.tracker.sources[2]).toEqual({
    kind: 'files',
    role: 'staging',
    paths: ['README.md'],
  })
  expect(trackerLinks(linked?.tracker ?? tracker(), variants, schema).rules[1]?.missing).toEqual([])
})

test('linkSource falls back to a read role and skips links that exist', () => {
  expect(linkSource(tracker(), variants, schema, 2, 0)?.role).toBe('definition')
  expect(linkSource(tracker(), variants, schema, 0, 0)).toBeUndefined()
  expect(linkSource(tracker(), variants, schema, 9, 0)).toBeUndefined()
})

test('normalizeTrackers fills the entity and drops junk', () => {
  expect(normalizeTrackers([{ id: 't', name: 'T', sources: [{ kind: 'files' }, 1] }, 'x'])).toEqual(
    [
      {
        id: 't',
        name: 'T',
        entity: { label: 'Entity', key: { normalize: [] } },
        sources: [{ kind: 'files' }],
        rules: [],
        outputs: [],
      },
    ],
  )
  expect(normalizeTrackers(null)).toEqual([])
})

test('trackerProblems mirrors the server checks', () => {
  const problems = trackerProblems([
    tracker(),
    tracker({
      name: '',
      sources: [],
      rules: [{ kind: 'unused' }, { kind: 'unused' }],
      entity: { label: 'Flag', key: { normalize: ['lower', 'shout'] } },
    }),
    tracker({ id: '-bad' }),
  ])
  expect([...problems]).toEqual([
    [
      1,
      [
        'Id flags is used twice',
        'Give the tracker a name',
        'Add at least one source',
        'Unknown normalize step shout',
        'Two rules share the id unused; give them distinct ids',
      ],
    ],
    [2, ['Id starts with a letter or digit and uses letters, digits, dots, dashes, underscores']],
  ])
})

describe('new values', () => {
  test('newTracker picks a free id', () => {
    expect(newTracker(['tracker-2']).id).toBe('tracker-3')
  })

  test('newPart starts from the required fields', () => {
    expect(newPart('files', variants.sources.get('files'), schema)).toEqual({
      kind: 'files',
      role: '',
      paths: [],
    })
  })
})

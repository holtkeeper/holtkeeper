import { expect, test } from 'bun:test'

import { normalizeRenovateValue, reader, renovateFields, renovateSummary } from './renovate.ts'

const schema = {
  type: 'object',
  'x-editor': 'renovate',
  properties: {
    mode: { title: 'Mode', description: 'Report or open merge requests.', default: 'report' },
    releaseAgeDays: { title: 'Release age', default: 3 },
    majors: { default: true },
    concurrentLimit: { default: 10 },
    grouping: { default: 'separate' },
  },
}

const fields = renovateFields(schema)

test('reads titles, descriptions and defaults from the schema', () => {
  expect(fields.mode).toEqual({
    title: 'Mode',
    description: 'Report or open merge requests.',
    default: 'report',
  })
  expect(fields.majors).toEqual({ title: 'majors', default: true })
  expect(renovateFields(undefined)).toEqual({})
})

test('set options win over defaults', () => {
  expect(reader({}, fields).number('releaseAgeDays', 0)).toBe(3)
  expect(reader({ releaseAgeDays: 7 }, fields).number('releaseAgeDays', 0)).toBe(7)
  expect(reader({}, fields).text('unknown', 'x')).toBe('x')
  expect(reader({ mode: 5 }, fields).text('mode', 'x')).toBe('x')
  expect(normalizeRenovateValue('nope')).toEqual({})
})

test('summarizes the default and merge-request setups in plain words', () => {
  expect(renovateSummary({}, fields)).toBe(
    'Renovate looks up every update, majors included; Holtkeeper reports them and pushes nothing. An update counts once a release is 3 days old.',
  )
  expect(
    renovateSummary(
      {
        mode: 'merge-requests',
        grouping: 'non-major',
        releaseAgeDays: 1,
        lockFileMaintenance: true,
      },
      fields,
    ),
  ).toBe(
    'Renovate opens merge requests for every update, majors included, once a release is 1 day old: minor and patch updates in one merge request, at most 10 open at a time. Lockfiles are refreshed weekly.',
  )
  expect(
    renovateSummary(
      { mode: 'merge-requests', majors: false, releaseAgeDays: 0, concurrentLimit: 0 },
      fields,
    ),
  ).toBe(
    'Renovate opens merge requests for minor and patch updates, as soon as they are released: one merge request per dependency, with no limit on open ones.',
  )
  expect(renovateSummary({ mode: 'merge-requests', updates: 'security' }, fields)).toBe(
    'Renovate opens merge requests only for updates that fix a known vulnerability, right away: one per fix, at most 10 open at a time.',
  )
})

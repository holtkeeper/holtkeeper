import { expect, test } from 'bun:test'

import { assessUsage, lagOf, type LifecycleCycle, matchCycle, supportOf } from './index.ts'

const node: LifecycleCycle[] = [
  { cycle: '26', eol: '2029-04-30', latest: '26.1.0' },
  { cycle: '24', eol: '2028-04-30', lts: '2025-10-28', latest: '24.11.0' },
  { cycle: '22', eol: '2027-04-30', lts: '2024-10-29', latest: '22.21.0' },
  { cycle: '20', eol: '2026-04-30', lts: '2023-10-24', latest: '20.19.5' },
  { cycle: '18', eol: '2025-04-30', lts: true, latest: '18.20.8' },
]
const python: LifecycleCycle[] = [
  { cycle: '3.14', eol: '2030-10-31', latest: '3.14.0' },
  { cycle: '3.13', eol: '2029-10-31', latest: '3.13.8' },
  { cycle: '3.9', eol: '2025-10-31', latest: '3.9.24' },
]
const at = new Date('2026-10-30T00:00:00Z')

test('compares only as far as a version is written', () => {
  expect(lagOf('22', '22.21.0')).toBe('current')
  expect(lagOf('22.4', '22.21.0')).toBe('minor')
  expect(lagOf('22.21.0', '22.21.1')).toBe('patch')
  expect(lagOf('20.1.0', '22.21.0')).toBe('major')
  expect(lagOf('27', '26.1.0')).toBe('ahead')
  expect(lagOf('lts', '26.1.0')).toBe('unknown')
})

test('matches release lines by prefix, floating versions to the newest line', () => {
  expect(matchCycle('22.11.0', node)?.cycle).toBe('22')
  expect(matchCycle('3.13.1', python)?.cycle).toBe('3.13')
  expect(matchCycle('3', python)?.cycle).toBe('3.14')
  expect(matchCycle('16', node)).toBeUndefined()
})

test('judges support at the analysis time', () => {
  expect(supportOf(node[4], at, 180)).toBe('eol')
  expect(supportOf(node[3], at, 180)).toBe('eol')
  expect(supportOf(node[2], at, 180)).toBe('lts')
  expect(supportOf(node[0], at, 180)).toBe('active')
  expect(supportOf({ cycle: '9', eol: '2027-01-15' }, at, 180)).toBe('eol-soon')
  expect(supportOf(undefined, at, 180)).toBe('unknown')
})

test('assesses usages against the latest release and their own line', () => {
  const component = { latest: '26.1.0', cycles: node }
  const usage = { repo: 'acme/web', file: '.nvmrc', via: 'version-file' as const }
  expect(
    assessUsage(component, { ...usage, declared: '22.3.0', version: '22.3.0' }, at, 180),
  ).toMatchObject({
    lag: 'major',
    support: 'lts',
    majorsBehind: 4,
    cycleLatest: '22.21.0',
    eolDate: '2027-04-30',
  })
  expect(assessUsage(component, { ...usage, declared: 'lts' }, at, 180)).toEqual({
    lag: 'floating',
    support: 'unknown',
  })
})

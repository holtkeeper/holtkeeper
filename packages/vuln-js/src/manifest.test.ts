import { describe, expect, test } from 'bun:test'

import type { Finding } from '@holtkeeper/vuln'

import { formatManifest, planManifestEdits } from './manifest.ts'

const finding = (
  id: string,
  name: string,
  version: string,
  fixedVersions: string[],
  ecosystem = 'npm',
): Finding => ({
  id,
  aliases: [],
  summary: '',
  severity: 'high',
  url: '',
  package: { name, version, ecosystem },
  source: 'package-lock.json',
  fixedVersions,
})

describe('planManifestEdits', () => {
  test('raises a direct dependency whose range admits the vulnerable version', () => {
    const input = { dependencies: { lodash: '4.17.15' }, devDependencies: { lodash: '^4.0.0' } }
    const plan = planManifestEdits(
      input,
      [finding('GHSA-1', 'lodash', '4.17.15', ['4.17.21'])],
      'npm',
    )
    expect(plan.manifest).toEqual({
      dependencies: { lodash: '^4.17.21' },
      devDependencies: { lodash: '^4.17.21' },
    })
    expect(plan.fixed).toEqual(['GHSA-1'])
    expect(input.dependencies.lodash).toBe('4.17.15')
  })

  test('adds selector overrides for npm, bun and pnpm', () => {
    const findings = [finding('GHSA-qs', 'qs', '6.7.0', ['6.7.3'])]
    expect(planManifestEdits({}, findings, 'npm').manifest).toEqual({
      overrides: { 'qs@>=6.7.0 <6.7.3': '^6.7.3' },
    })
    expect(planManifestEdits({}, findings, 'bun').manifest).toEqual({
      overrides: { 'qs@>=6.7.0 <6.7.3': '^6.7.3' },
    })
    expect(planManifestEdits({ pnpm: { neverBuiltDependencies: [] } }, findings, 'pnpm')).toEqual({
      manifest: {
        pnpm: { neverBuiltDependencies: [], overrides: { 'qs@>=6.7.0 <6.7.3': '^6.7.3' } },
      },
      changed: true,
      fixed: ['GHSA-qs'],
      notes: [],
    })
  })

  test('uses plain names for yarn resolutions', () => {
    const plan = planManifestEdits(
      { resolutions: { other: '1.0.0' } },
      [finding('GHSA-qs', 'qs', '6.7.0', ['6.7.3'])],
      'yarn-berry',
    )
    expect(plan.manifest).toEqual({ resolutions: { other: '1.0.0', qs: '^6.7.3' } })
  })

  test('takes the highest target per package and major line', () => {
    const findings = [
      finding('A', 'qs', '6.7.0', ['6.7.3']),
      finding('B', 'qs', '6.5.0', ['6.10.3']),
      finding('C', 'qs', '2.3.0', ['2.3.3']),
    ]
    expect(planManifestEdits({}, findings, 'npm').manifest).toEqual({
      overrides: { 'qs@>=6.5.0 <6.10.3': '^6.10.3', 'qs@>=2.3.0 <2.3.3': '^2.3.3' },
    })
    expect(planManifestEdits({}, findings, 'yarn-classic').manifest).toEqual({
      resolutions: { qs: '^6.10.3' },
    })
  })

  test('replaces an existing override that still admits the vulnerable version', () => {
    const plan = planManifestEdits(
      { overrides: { qs: '6.7.0', other: '1.0.0' } },
      [finding('GHSA-qs', 'qs', '6.7.0', ['6.7.3'])],
      'npm',
    )
    expect(plan.manifest).toEqual({ overrides: { qs: '^6.7.3', other: '1.0.0' } })
  })

  test('keeps an existing override that already excludes the vulnerable version', () => {
    const input = { overrides: { qs: '^7.0.0' } }
    const plan = planManifestEdits(input, [finding('GHSA-qs', 'qs', '6.7.0', ['6.7.3'])], 'npm')
    expect(plan.changed).toBe(false)
    expect(plan.manifest).toBe(input)
    expect(plan.notes).toEqual(['GHSA-qs: qs already has override "qs": "^7.0.0"; left as is'])
  })

  test('skips findings it cannot fix, with notes', () => {
    const plan = planManifestEdits(
      { dependencies: { local: 'file:../local', ok: '^2.0.0' }, overrides: { nested: { x: '1' } } },
      [
        finding('NOFIX', 'a', '1.0.0', []),
        finding('DOWN', 'b', '2.0.0', ['1.9.0']),
        finding('GO', 'golang.org/x/text', '0.3.0', ['0.3.8'], 'Go'),
        finding('FILE', 'local', '1.0.0', ['1.0.1']),
        finding('NESTED', 'nested', '1.0.0', ['1.0.1']),
        finding('TRANS', 'ok', '1.0.0', ['1.0.1']),
      ],
      'npm',
    )
    expect(plan.changed).toBe(false)
    expect(plan.fixed).toEqual([])
    expect(plan.notes).toHaveLength(6)
    expect(plan.notes.join('\n')).toContain('NOFIX: no fixed version')
    expect(plan.notes.join('\n')).toContain('DOWN: fix 1.9.0 is not newer')
    expect(plan.notes.join('\n')).toContain('not a semver range')
    expect(plan.notes.join('\n')).toContain('non-version override')
    expect(plan.notes.join('\n')).toContain('TRANS: ok is a direct dependency')
  })
})

describe('formatManifest', () => {
  test('keeps indentation and trailing newline', () => {
    expect(formatManifest('{\n    "a": 1\n}\n', { a: 2 })).toBe('{\n    "a": 2\n}\n')
    expect(formatManifest('{\n\t"a": 1\n}', { a: 2 })).toBe('{\n\t"a": 2\n}')
    expect(formatManifest('{\r\n  "a": 1\r\n}\r\n', { a: 2 })).toBe('{\r\n  "a": 2\r\n}\r\n')
  })
})

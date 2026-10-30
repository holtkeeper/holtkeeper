import { describe, expect, test } from 'bun:test'

import type { Finding } from '@holtkeeper/vuln'

import { planGoUpgrades } from './plan.ts'

function finding(id: string, name: string, version: string, fixedVersions: string[]): Finding {
  return {
    id,
    aliases: [],
    summary: '',
    severity: 'high',
    url: '',
    package: { name, version, ecosystem: 'Go' },
    source: 'go.mod',
    fixedVersions,
  }
}

describe('planGoUpgrades', () => {
  test('upgrades each module to the highest first fixed version', () => {
    const plan = planGoUpgrades([
      finding('GO-1', 'golang.org/x/text', '0.3.0', ['0.3.3']),
      finding('GO-2', 'golang.org/x/net', 'v0.1.0', ['v0.7.0', 'v0.9.0']),
      finding('GO-3', 'golang.org/x/text', '0.3.0', ['0.3.10']),
      finding('GO-4', 'golang.org/x/text', '0.3.0', ['0.3.8']),
    ])
    expect(plan).toEqual({
      upgrades: [
        { module: 'golang.org/x/text', version: 'v0.3.10', findingIds: ['GO-1', 'GO-3', 'GO-4'] },
        { module: 'golang.org/x/net', version: 'v0.7.0', findingIds: ['GO-2'] },
      ],
      notes: [],
    })
  })

  test('never plans a downgrade', () => {
    const plan = planGoUpgrades([finding('GO-1', 'example.com/m', '1.4.0', ['1.2.0'])])
    expect(plan.upgrades).toEqual([])
    expect(plan.notes).toEqual([
      'GO-1: fixed version 1.2.0 of example.com/m is not newer than 1.4.0',
    ])
  })

  test('only notes stdlib and toolchain findings', () => {
    const plan = planGoUpgrades([
      finding('GO-1', 'stdlib', '1.22.0', ['1.22.5']),
      finding('GO-2', 'stdlib', '1.22.0', ['1.22.7']),
      finding('GO-3', 'toolchain', '1.22.0', ['1.22.2']),
    ])
    expect(plan.upgrades).toEqual([])
    expect(plan.notes).toEqual([
      'stdlib: upgrade the Go toolchain to go1.22.7 or later (GO-1, GO-2)',
      'toolchain: upgrade the Go toolchain to go1.22.2 or later (GO-3)',
    ])
  })

  test('skips findings without a fix and other ecosystems', () => {
    const npm = finding('GHSA-1', 'lodash', '4.17.15', ['4.17.21'])
    npm.package.ecosystem = 'npm'
    const plan = planGoUpgrades([finding('GO-1', 'example.com/m', '1.0.0', []), npm])
    expect(plan.upgrades).toEqual([])
    expect(plan.notes).toEqual([
      'GO-1: no fixed version of example.com/m is known',
      'GHSA-1: lodash is in ecosystem npm, not Go',
    ])
  })
})

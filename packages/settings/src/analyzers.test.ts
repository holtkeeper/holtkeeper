import { describe, expect, test } from 'bun:test'

import type { SettingEntry } from '@holtkeeper/store'
import { z } from 'zod'

import { analyzerOff, resolveRepoAnalyzers } from './analyzers.ts'
import { repoAnalyzersSetting } from './definitions.ts'

const widget = { forge: 'acme', path: 'shapes/widget', groups: ['shapes'] }
const core = { forge: 'acme', path: 'shapes/widget-core', groups: ['shapes'] }

const entry = (
  id: string,
  scope: SettingEntry['scope'],
  value: unknown,
  secret = false,
): SettingEntry => ({
  id,
  key: 'repo.analyzers',
  scope,
  value,
  secret,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

describe('repo.analyzers', () => {
  test('nothing is off without an entry', () => {
    expect(resolveRepoAnalyzers([], widget)).toEqual({ off: [] })
    expect(analyzerOff([], widget, 'audit')).toBeUndefined()
  })

  test('a group entry turns analyzers off and a repository entry turns them back on', () => {
    const group = entry('g', { groups: ['shapes'] }, { off: ['audit'], reason: 'Values only' })
    const own = entry('r', { repos: ['shapes/widget-core'] }, { off: [] })
    expect(resolveRepoAnalyzers([group, own], widget)).toEqual({
      off: ['audit'],
      reason: 'Values only',
      entry: group,
    })
    expect(analyzerOff([group, own], widget, 'audit')).toEqual({ reason: 'Values only' })
    expect(analyzerOff([group, own], widget, 'coverage')).toBeUndefined()
    expect(resolveRepoAnalyzers([group, own], core)).toEqual({ off: [], entry: own })
    expect(analyzerOff([group, own], core, 'audit')).toBeUndefined()
  })

  test('invalid and secret values count as the default', () => {
    expect(resolveRepoAnalyzers([entry('a', { all: true }, 'audit')], widget)).toEqual({
      off: [],
    })
    expect(
      resolveRepoAnalyzers([entry('s', { all: true }, { off: ['audit'] }, true)], widget),
    ).toEqual({ off: [] })
  })

  test('the definition accepts only the kinds it was built with, labelled for editors', () => {
    const definition = repoAnalyzersSetting([
      { kind: 'audit', label: 'Vulnerabilities' },
      { kind: 'bundle', label: 'Bundle size' },
    ])
    expect(definition.schema.parse({ off: ['audit'], reason: 'Values only' })).toEqual({
      off: ['audit'],
      reason: 'Values only',
    })
    expect(definition.schema.safeParse({ off: ['gadget'] }).success).toBe(false)
    expect(definition.schema.safeParse({ off: [], reason: '  ' }).success).toBe(false)
    expect(definition.schema.parse({})).toEqual({ off: [] })
    expect(definition.default).toEqual({ off: [] })
    const json = JSON.stringify(z.toJSONSchema(definition.schema, { io: 'input' }))
    expect(json).toContain('"x-labels":{"audit":"Vulnerabilities","bundle":"Bundle size"}')
    expect(repoAnalyzersSetting([]).schema.safeParse({ off: ['audit'] }).success).toBe(false)
  })
})

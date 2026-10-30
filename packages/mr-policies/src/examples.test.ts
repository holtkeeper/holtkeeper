import { describe, expect, test } from 'bun:test'

import { examplePolicies } from '../test/examples.ts'
import { diffFile, fakeForge, mrEvent, pipeline } from '../test/fake-forge.ts'
import { evaluatePolicies } from './engine.ts'
import { createMemory } from './memory.ts'
import { combinePolicies } from './settings.ts'

const repo = { forge: 'work', path: 'games/slots', groups: ['games'] }
const { policies, invalid } = combinePolicies(
  [{ scope: { groups: ['games'] }, value: examplePolicies }],
  repo,
)

describe('documented examples', () => {
  test('parse', () => {
    expect(invalid).toEqual([])
    expect(policies).toHaveLength(4)
  })

  test('release bot MRs to main are approved once green and skip analysis', async () => {
    const event = mrEvent({
      authorIsBot: true,
      mr: { author: 'release-bot', sourceBranch: 'release/3.1', headSha: 'sha1' },
    })
    const { forge, calls } = fakeForge({
      pipelines: [pipeline('success')],
      files: [diffFile('src/a.ts')],
    })
    const result = await evaluatePolicies({ policies, event, forge, memory: createMemory() })
    expect(result.matched.map((m) => m.policyId)).toEqual(['release-auto-approve'])
    expect(result.skipAnalyzers).toBe('*')
    expect(calls.map((c) => c.method)).toEqual(['listPipelines', 'submitReview'])
  })

  test('renovate patch updates are approved and merged', async () => {
    const event = mrEvent({ mr: { author: 'renovate-bot', labels: ['patch'], headSha: 'sha1' } })
    const { forge } = fakeForge({
      pipelines: [pipeline('success')],
      files: [diffFile('package.json')],
    })
    const result = await evaluatePolicies({ policies, event, forge, memory: createMemory() })
    expect(result.outcomes.map((o) => [o.action, o.status])).toEqual([
      ['approve', 'done'],
      ['merge', 'done'],
    ])
    expect(result.skipAnalyzers).toEqual(['review'])
  })

  test('docs-only MRs are labelled and skip review; large MRs get needs-review', async () => {
    const docs = await evaluatePolicies({
      policies,
      event: mrEvent(),
      forge: fakeForge({ files: [diffFile('README.md'), diffFile('docs/guide/setup.md')] }).forge,
      memory: createMemory(),
    })
    expect(docs.matched.map((m) => m.policyId)).toEqual(['docs-only'])
    expect(docs.skipAnalyzers).toEqual(['review'])

    const large = await evaluatePolicies({
      policies,
      event: mrEvent(),
      forge: fakeForge({ files: [diffFile('src/a.ts', 800), diffFile('src/b.ts', 300)] }).forge,
      memory: createMemory(),
    })
    expect(large.matched.map((m) => m.policyId)).toEqual(['large-needs-review'])
    expect(large.outcomes.map((o) => o.detail)).toEqual(['added needs-review', 'commented'])
  })
})

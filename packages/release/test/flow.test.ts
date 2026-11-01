import { describe, expect, test } from 'bun:test'

import {
  type Acceptance,
  GateError,
  boardRow,
  collectFacts,
  createVersion,
  planRelease,
  proposeRelease,
  readDeployState,
  refreshProposal,
  releaseMarker,
  releaseSettings,
  releaseStage,
  startDeploy,
  DeployError,
} from '../src/index.ts'
import { FakeForge } from '../src/testing.ts'

const now = new Date('2026-11-01T09:00:00Z')
const repo = { forge: 'work', path: 'g/app' }

function deferredFlow() {
  const fake = new FakeForge()
  fake.commitTo('main', 'feat: [GTW-1] first screen')
  fake.tag('v1.0.0')
  fake.commitTo('development', 'feat: [GTW-2] statistics window', 'fix: [GTW-3] crash on load')
  return fake
}

const settings = releaseSettings({
  acceptance: { required: true, signals: ['manual', 'label'] },
  deploy: {
    environments: [
      { name: 'preprod', job: 'deploy:preprod' },
      { name: 'prod', job: 'deploy:prod', after: 'preprod' },
    ],
  },
})

const facts = (fake: FakeForge, recorded?: Acceptance) =>
  collectFacts({ forge: fake.forge, repo, settings, ...(recorded ? { recorded } : {}) })

describe('merge request flow with the version after acceptance', () => {
  test('goes from candidate to deployed', async () => {
    const fake = deferredFlow()
    const context = { forge: fake.forge, repo, settings, now }

    let current = await facts(fake)
    expect(releaseStage(settings, current)).toBe('candidate')
    expect(boardRow(settings, current, now)).toMatchObject({
      stage: 'candidate',
      latest: { tag: 'v1.0.0' },
      next: '1.1.0',
      ahead: 2,
      tickets: ['GTW-2', 'GTW-3'],
    })

    const proposal = planRelease({ step: 'propose', facts: current, settings, now })
    expect(proposal.title).toBe('Release candidate 2026-11-01')
    expect(proposal.body).toContain('Next version if released now: **1.1.0**')
    expect(proposal.body).toContain('- statistics window (GTW-2')
    expect(proposal.body.endsWith(releaseMarker)).toBe(true)

    const opened = await proposeRelease(context, current, proposal)
    expect(opened.created).toBe(true)

    fake.commitTo('development', 'perf: faster table')
    current = await facts(fake)
    expect(releaseStage(settings, current)).toBe('proposed')
    const refreshed = planRelease({ step: 'propose', facts: current, settings, now })
    expect(await refreshProposal(context, current, refreshed)).toBe(true)
    expect(fake.requests[0]?.description).toContain('faster table')

    fake.merge('development', 'main')
    current = await facts(fake)
    expect(releaseStage(settings, current)).toBe('awaiting-version')
    expect(current.merged?.id).toBe(1)

    const blocked = planRelease({ step: 'version', facts: current, settings, now })
    expect(blocked.gates.find((gate) => gate.id === 'acceptance')?.ok).toBe(false)
    expect(createVersion(context, current, blocked)).rejects.toBeInstanceOf(GateError)

    current = await facts(fake, {
      sha: current.target.sha,
      by: 'qa-lead',
      at: now.toISOString(),
      via: 'manual',
    })
    const version = planRelease({
      step: 'version',
      facts: current,
      settings,
      now,
      edits: { version: '1.2.0' },
    })
    expect(version.suggested.version).toBe('1.1.0')
    expect(version.tag).toBe('v1.2.0')
    expect(version.gates.every((gate) => gate.ok)).toBe(true)
    expect(version.entries.filter((entry) => entry.included).map((entry) => entry.text)).toEqual([
      'statistics window',
      'crash on load',
      'faster table',
    ])

    const created = await createVersion(context, current, version)
    expect(created).toMatchObject({ version: '1.2.0', tag: 'v1.2.0', sha: current.target.sha })
    expect(
      fake.calls.filter((call) => call.startsWith('tag') || call.startsWith('release')),
    ).toEqual(['tag v1.2.0 Release 1.2.0', 'release v1.2.0'])
    expect(fake.releases.get('v1.2.0')?.description).toContain('### Features')
    expect(releaseStage(settings, await facts(fake))).toBe('released')

    fake.addPipeline('v1.2.0', 'manual', [
      { name: 'build', status: 'success' },
      { name: 'deploy:preprod', status: 'manual' },
      { name: 'deploy:prod', status: 'manual' },
    ])
    let deploy = await readDeployState(fake.forge, repo, settings, 'v1.2.0')
    expect(deploy.environments.map((env) => [env.name, env.status])).toEqual([
      ['preprod', 'ready'],
      ['prod', 'waiting'],
    ])
    expect(startDeploy({ ...context, tag: 'v1.2.0', environment: 'prod' })).rejects.toBeInstanceOf(
      DeployError,
    )

    await startDeploy({ ...context, tag: 'v1.2.0', environment: 'preprod' })
    fake.jobs.get(1)![1]!.status = 'failed'
    deploy = await readDeployState(fake.forge, repo, settings, 'v1.2.0')
    expect(deploy.environments[0]?.status).toBe('failed')

    await startDeploy({ ...context, tag: 'v1.2.0', environment: 'preprod' })
    deploy = await readDeployState(fake.forge, repo, settings, 'v1.2.0')
    expect(deploy.environments[0]).toMatchObject({ status: 'pending' })
    expect(deploy.environments[0]?.attempts.map((attempt) => attempt.status)).toEqual([
      'pending',
      'failed',
    ])
    fake.jobs.get(1)!.at(-1)!.status = 'success'
    deploy = await readDeployState(fake.forge, repo, settings, 'v1.2.0')
    expect(deploy.environments.map((env) => env.status)).toEqual(['success', 'ready'])
  })

  test('accepts through the label on the merged merge request', async () => {
    const fake = deferredFlow()
    await proposeRelease(
      { forge: fake.forge, repo, settings, now },
      await facts(fake),
      planRelease({ step: 'propose', facts: await facts(fake), settings, now }),
    )
    fake.merge('development', 'main')
    fake.requests[0]!.labels = ['release-accepted']
    const current = await facts(fake)
    expect(current.acceptance).toMatchObject({ via: 'label', sha: current.target.sha })
  })
})

describe('trunk flow', () => {
  test('versions straight from the target branch with a changelog file', async () => {
    const fake = new FakeForge()
    fake.commitTo('main', 'feat: one')
    const trunk = releaseSettings({
      flow: { mode: 'trunk' },
      tag: { changelogFile: { enabled: true } },
    })
    const current = await collectFacts({ forge: fake.forge, repo, settings: trunk })
    expect(current.source).toBeUndefined()
    expect(releaseStage(trunk, current)).toBe('awaiting-version')
    const plan = planRelease({ step: 'version', facts: current, settings: trunk, now })
    expect(plan.version).toBe('0.1.0')
    const created = await createVersion(
      { forge: fake.forge, repo, settings: trunk, now },
      current,
      plan,
    )
    expect(created.changelogCommit).toBeDefined()
    const file = fake.files.get('CHANGELOG.md') ?? ''
    expect(
      file.startsWith('# Changelog\n\n## 0.1.0 (2026-11-01)\n\n1 feature, 1 other change.'),
    ).toBe(true)
    expect(file).toContain('### Features\n\n- one (')
    expect(created.sha).toBe(fake.branches.get('main')!)
  })

  test('refuses an empty release even when forced', async () => {
    const fake = new FakeForge()
    fake.tag('v1.0.0')
    const trunk = releaseSettings({ flow: { mode: 'trunk' } })
    const current = await collectFacts({ forge: fake.forge, repo, settings: trunk })
    expect(releaseStage(trunk, current)).toBe('released')
    const plan = planRelease({ step: 'version', facts: current, settings: trunk, now })
    expect(
      createVersion({ forge: fake.forge, repo, settings: trunk, now }, current, plan, {
        force: true,
      }),
    ).rejects.toThrow('nothing to release')
  })
})

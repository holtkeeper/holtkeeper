import { expect, test } from 'bun:test'

import type { Digest, DigestPreset } from '@holtkeeper/api'

import {
  digestDraft,
  draftInput,
  draftProblems,
  editSection,
  newDraft,
  presetDraft,
  targetsText,
  toggleSection,
} from './digests.ts'

const preset: DigestPreset = {
  id: 'weekly-compliance',
  label: 'Weekly compliance',
  description: 'Licenses and audits',
  input: {
    name: 'Weekly compliance',
    schedule: { every: 'week', days: ['mon'], time: '10:00' },
    sections: [{ source: 'licenses', minTone: 'warning' }, { source: 'audit' }],
  },
}

test('presets keep the sections the server knows', () => {
  const draft = presetDraft(preset, new Set(['licenses']), 'Europe/Berlin')
  expect(draft).toMatchObject({ name: 'Weekly compliance', timezone: 'Europe/Berlin', panel: true })
  expect(draft.sections).toEqual([{ source: 'licenses', minTone: 'warning', limit: 8 }])
})

test('drafts become inputs with cleaned channels and the caller’s chat', () => {
  const draft = {
    ...newDraft('UTC'),
    name: ' Hygiene ',
    all: false,
    groups: ['games'],
    sections: [{ source: 'assets', minTone: 'info' as const, limit: 5 }],
    slackChannels: ['#frontend', 'frontend', ' '],
  }
  const existing = {
    targets: [
      { kind: 'panel', userId: 'bob' },
      { kind: 'panel', userId: 'jane' },
    ],
  } as Digest
  expect(draftInput(draft, 'jane', existing)).toEqual({
    name: 'Hygiene',
    enabled: true,
    scope: { groups: ['games'] },
    schedule: { every: 'week', days: ['mon'], dayOfMonth: 1, time: '10:00', timezone: 'UTC' },
    sections: [{ source: 'assets', minTone: 'info', limit: 5 }],
    onlyNew: false,
    skipEmpty: true,
    targets: [
      { kind: 'slack', channel: 'frontend' },
      { kind: 'panel', userId: 'jane' },
      { kind: 'panel', userId: 'bob' },
    ],
  })
})

test('saved digests come back as drafts', () => {
  const digest: Digest = {
    id: 'd1',
    name: 'Weekly',
    enabled: false,
    scope: { groups: ['games', ['web', 'shop']] },
    schedule: { every: 'month', days: ['mon'], dayOfMonth: 3, time: '08:00', timezone: 'UTC' },
    sections: [{ source: 'licenses', minTone: 'bad', limit: 3 }],
    onlyNew: true,
    skipEmpty: false,
    targets: [{ kind: 'slack', channel: 'C1' }],
    createdBy: 'jane',
    createdAt: '',
    updatedAt: '',
  }
  expect(digestDraft(digest, 'jane')).toMatchObject({
    all: false,
    groups: ['games'],
    every: 'month',
    dayOfMonth: 3,
    slackChannels: ['C1'],
    panel: false,
  })
})

test('problems, sections and targets in words', () => {
  expect(draftProblems({ ...newDraft('UTC'), all: false, days: [], time: '9:30' })).toEqual([
    'Give it a name',
    'Pick at least one section',
    'Pick the groups it covers',
    'Pick at least one day',
    'Use a time like 09:30',
  ])
  let draft = toggleSection(newDraft('UTC'), 'licenses')
  draft = editSection(draft, 'licenses', { minTone: 'bad' })
  expect(draft.sections).toEqual([{ source: 'licenses', minTone: 'bad', limit: 8 }])
  expect(toggleSection(draft, 'licenses').sections).toEqual([])
  expect(
    targetsText(
      [
        { kind: 'slack', channel: 'releases' },
        { kind: 'panel', userId: 'jane' },
        { kind: 'panel', userId: 'bob' },
      ],
      'jane',
    ),
  ).toBe('#releases, your chat, a panel chat')
  expect(targetsText([], 'jane')).toBe('nowhere yet')
})

import { expect, test } from 'bun:test'

import type { Agent } from '@holtkeeper/agent'

import {
  announcedTag,
  packageEntries,
  previousTag,
  releaseAnnounceSchema,
  releaseAnnounceSettings,
} from './announce.ts'
import { releaseSettings } from './settings.ts'
import { writeAnnouncementNotes } from './summary.ts'

const settings = releaseSettings({})
const tag = (name: string) => ({ name, sha: `sha-${name}` })

test('releases.announce defaults announce nothing and tolerate bad values', () => {
  expect(releaseAnnounceSettings(undefined)).toEqual({
    channels: [],
    groupWindowMinutes: 10,
    notes: true,
    tasks: true,
    impact: true,
  })
  expect(releaseAnnounceSettings({ channels: ['#widgets'] }).channels).toEqual([])
  expect(releaseAnnounceSchema.safeParse({ channels: ['C0123WIDGET'] }).success).toBe(true)
})

test('by default version tags of the flow and package tags are announced', () => {
  expect(announcedTag(settings, {}, tag('v1.2.3'))).toEqual({
    name: 'v1.2.3',
    sha: 'sha-v1.2.3',
    version: '1.2.3',
  })
  expect(announcedTag(settings, {}, tag('@acme/widgets@1.2.3'))).toEqual({
    name: '@acme/widgets@1.2.3',
    sha: 'sha-@acme/widgets@1.2.3',
    package: '@acme/widgets',
    version: '1.2.3',
  })
  expect(announcedTag(settings, {}, tag('nightly'))).toBeUndefined()
  const calendar = releaseSettings({
    version: { scheme: 'calver', tagFormat: 'release-{version}' },
  })
  expect(announcedTag(calendar, {}, tag('release-2026.11.1'))?.version).toBe('2026.11.1')
  expect(announcedTag(calendar, {}, tag('v1.2.3'))).toBeUndefined()
})

test('tag globs narrow what is announced', () => {
  const only = { tags: ['@acme/widgets@*'] }
  expect(announcedTag(settings, only, tag('@acme/widgets@2.0.0'))?.package).toBe('@acme/widgets')
  expect(announcedTag(settings, only, tag('@acme/gadgets@2.0.0'))).toBeUndefined()
  expect(announcedTag(settings, only, tag('v2.0.0'))).toBeUndefined()
  expect(announcedTag(settings, { tags: ['build-*'] }, tag('build-42'))?.version).toBe('build-42')
})

test('the previous version is the highest lower one of the same package', () => {
  const tags = [
    '@acme/widgets@1.0.0',
    '@acme/widgets@1.2.0',
    '@acme/widgets@1.3.0-rc.1',
    '@acme/gadgets@1.2.5',
    'v1.1.0',
    'v0.9.0',
  ].map(tag)
  const widgets = announcedTag(settings, {}, tag('@acme/widgets@1.3.0'))!
  expect(previousTag(settings, widgets, tags)?.name).toBe('@acme/widgets@1.2.0')
  const plain = announcedTag(settings, {}, tag('v1.2.0'))!
  expect(previousTag(settings, plain, tags)?.name).toBe('v1.1.0')
  const first = announcedTag(settings, {}, tag('@acme/sprockets@1.0.0'))!
  expect(previousTag(settings, first, tags)).toBeUndefined()
})

const fakeAgent = (
  tasks: { system?: string; prompt?: string; taskKind?: string; tier?: string }[],
) =>
  ({
    name: 'fake',
    run: async (task) => {
      tasks.push({
        system: task.system,
        prompt: task.prompt,
        taskKind: task.taskKind,
        tier: task.tier,
      })
      return {
        text: '',
        turns: 1,
        output: {
          packages: [
            {
              name: '@acme/widgets',
              overview: 'Widgets get sizes.',
              highlights: ['Sized widgets'],
              breaking: [{ change: 'Widget lost size', migration: 'Use scale instead.' }],
            },
          ],
        },
      } as never
    },
  }) satisfies Agent

test('announcement notes are one fast call in the asked language', async () => {
  const tasks: { system?: string; prompt?: string; taskKind?: string; tier?: string }[] = []
  const notes = await writeAnnouncementNotes(fakeAgent(tasks), {
    language: 'German',
    packages: [
      {
        name: '@acme/widgets',
        version: '2.0.0',
        previous: '1.4.0',
        entries: [],
        apiBreaking: [{ name: 'WidgetProps', change: 'changed', before: 'size: number' }],
      },
    ],
  })
  expect(notes[0]?.breaking[0]?.migration).toBe('Use scale instead.')
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ taskKind: 'release-notes', tier: 'fast' })
  expect(tasks[0]?.system).toContain('Write the prose in German')
  expect(tasks[0]?.prompt).toContain('WidgetProps')

  await writeAnnouncementNotes(fakeAgent(tasks), { packages: [] })
  expect(tasks[1]?.system).toContain('Write the prose in English')
})

const scopedEntry = (title: string, scope?: string) =>
  ({ id: title, title, text: title, included: true, ...(scope ? { scope } : {}) }) as never
const titles = (list: { title: string }[]) => list.map((item) => item.title)

test('package entries keep the commits scoped to the package and the unscoped ones', () => {
  const entries = [
    scopedEntry('round widgets', 'widgets'),
    scopedEntry('gadget size', 'gadgets'),
    scopedEntry('shared tooling'),
    scopedEntry('both', 'gadgets, widgets'),
  ]
  expect(titles(packageEntries(entries, '@acme/widgets'))).toEqual([
    'round widgets',
    'shared tooling',
    'both',
  ])
  expect(titles(packageEntries(entries, '@acme/sprockets'))).toHaveLength(4)
})

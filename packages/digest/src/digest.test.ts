import { describe, expect, test } from 'bun:test'

import { type AnalysisKind, defineAnalysis } from '@holtkeeper/report'
import type { AnalysisRecord } from '@holtkeeper/store'
import { z } from 'zod'

import { buildDigest, digestCard } from './build.ts'
import { digestInputSchema, digestScheduleSchema } from './model.ts'
import { digestPresets } from './presets.ts'
import { describeSchedule, digestDue, nextDigestRun, scheduleCron } from './schedule.ts'

interface Finding {
  id: string
  tone: 'good' | 'info' | 'warning' | 'bad'
  title: string
}

const licenses = defineAnalysis<{ findings: Finding[] }>({
  kind: 'licenses',
  label: 'Licenses',
  schema: z.object({ findings: z.array(z.any()) }),
  summarize: () => [],
  toReport: (record) => ({
    kind: 'licenses',
    title: 'Licenses',
    generatedAt: record.createdAt,
    metrics: [],
    sections: [
      {
        id: 'main',
        title: 'Findings',
        blocks: [
          {
            type: 'issues',
            items: record.data.findings.map((finding) => ({
              ...finding,
              href: `/analyses/${record.id}#${finding.id}`,
            })),
          },
        ],
      },
    ],
  }),
})

const record = (path: string, findings: Finding[]): AnalysisRecord => ({
  id: `r-${path}`,
  repo: { forge: 'work', path },
  kind: 'licenses',
  createdAt: '2026-11-01T00:00:00Z',
  data: { findings },
})

const kinds = new Map<string, AnalysisKind>([['licenses', licenses]])

const records = [
  record('games/app-x', [
    { id: 'gpl', tone: 'bad', title: 'GPL-3.0 in left-pad' },
    { id: 'unknown', tone: 'warning', title: 'Unknown license in tiny-lib' },
    { id: 'ok', tone: 'good', title: 'MIT everywhere else' },
  ]),
  record('games/app-y', [{ id: 'note', tone: 'info', title: 'Dual license in util' }]),
  record('tools/cli', [{ id: 'gpl', tone: 'bad', title: 'GPL-3.0 in other' }]),
]

const now = new Date('2026-11-02T10:00:00Z')

const schedule = (input: unknown) => digestScheduleSchema.parse(input)

describe('schedule', () => {
  test('builds cron expressions', () => {
    expect(scheduleCron(schedule({ every: 'week', days: ['mon', 'fri'], time: '09:05' }))).toBe(
      '5 9 * * 1,5',
    )
    expect(
      scheduleCron(
        schedule({
          every: 'day',
          days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          time: '08:00',
        }),
      ),
    ).toBe('0 8 * * *')
    expect(scheduleCron(schedule({ every: 'month', dayOfMonth: 3, time: '23:59' }))).toBe(
      '59 23 3 * *',
    )
  })

  test('finds the next run in the time zone and tells when it is due', () => {
    const monday = schedule({
      every: 'week',
      days: ['mon'],
      time: '10:00',
      timezone: 'Europe/Berlin',
    })
    expect(nextDigestRun(monday, new Date('2026-11-01T12:00:00Z'))?.toISOString()).toBe(
      '2026-11-02T09:00:00.000Z',
    )
    expect(digestDue(monday, new Date('2026-11-01T12:00:00Z'), now)).toBe(true)
    expect(digestDue(monday, new Date('2026-11-02T09:00:00Z'), now)).toBe(false)
  })

  test('describes schedules in words', () => {
    expect(describeSchedule(schedule({ every: 'week', days: ['mon'] }))).toBe(
      'Every Monday at 10:00',
    )
    expect(
      describeSchedule(
        schedule({ every: 'day', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:30' }),
      ),
    ).toBe('Weekdays at 09:30')
    expect(describeSchedule(schedule({ every: 'week', days: ['tue', 'thu'] }))).toBe(
      'Every Tue, Thu at 10:00',
    )
    expect(describeSchedule(schedule({ every: 'month', dayOfMonth: 2 }))).toBe(
      'Monthly on the 2nd at 10:00',
    )
    expect(describeSchedule(schedule({ every: 'month', dayOfMonth: 11 }))).toBe(
      'Monthly on the 11th at 10:00',
    )
  })
})

const games = (repo: { path: string }) => repo.path.startsWith('games/')

describe('build', () => {
  const digest = {
    id: 'd1',
    sections: [{ source: 'licenses', minTone: 'warning' as const, limit: 1 }],
    onlyNew: false,
  }

  test('collects issues in scope at the tone, most serious first, with a limit', () => {
    const result = buildDigest({
      digest,
      records,
      kinds,
      covers: games,
      resolveUrl: (href) => `https://holt.example${href}`,
      now,
    })
    expect(result.sections[0]).toMatchObject({ label: 'Licenses', total: 2, repos: 2 })
    expect(result.sections[0]?.items).toEqual([
      {
        key: 'licenses:work:games/app-x:gpl',
        repo: { forge: 'work', path: 'games/app-x' },
        title: 'GPL-3.0 in left-pad',
        url: 'https://holt.example/analyses/r-games/app-x#gpl',
        tone: 'bad',
      },
    ])
    expect(result.keys).toEqual([
      'licenses:work:games/app-x:gpl',
      'licenses:work:games/app-x:unknown',
    ])
    expect(result.empty).toBe(false)
  })

  test('leaves out what the previous digest listed', () => {
    const result = buildDigest({
      digest: {
        ...digest,
        onlyNew: true,
        sections: [{ source: 'licenses', minTone: 'info', limit: 10 }],
      },
      records,
      kinds,
      covers: games,
      previousKeys: new Set(['licenses:work:games/app-x:gpl', 'licenses:work:games/app-x:unknown']),
      now,
    })
    expect(result.sections[0]?.items.map((item) => item.title)).toEqual(['Dual license in util'])
    expect(result.keys).toHaveLength(3)
  })

  test('unknown kinds are empty sections', () => {
    const result = buildDigest({
      digest: { ...digest, sections: [{ source: 'bundle', minTone: 'info', limit: 5 }] },
      records,
      kinds,
      covers: () => true,
      now,
    })
    expect(result.empty).toBe(true)
  })

  test('cards show counts, items, more and all-clear sections', () => {
    const result = buildDigest({
      digest: {
        ...digest,
        sections: [
          { source: 'licenses', minTone: 'warning', limit: 1 },
          { source: 'bundle', minTone: 'info', limit: 5 },
        ],
      },
      records,
      kinds,
      covers: games,
      now,
    })
    const card = digestCard({ name: 'Weekly compliance', onlyNew: false }, result, {
      url: 'https://holt.example/digests',
      subtitle: 'games',
    })
    expect(card.tone).toBe('bad')
    expect(card.blocks).toEqual([
      { type: 'context', text: 'games' },
      { type: 'text', text: '**Licenses** · 2 items in 1 repository' },
      {
        type: 'list',
        items: [
          {
            text: '`games/app-x` · GPL-3.0 in left-pad',
            tone: 'bad',
            url: '/analyses/r-games/app-x#gpl',
          },
        ],
      },
      { type: 'context', text: 'and 1 more' },
      { type: 'context', text: 'All clear: bundle' },
    ])
    const empty = digestCard(
      { name: 'Quiet', onlyNew: true },
      { ...result, sections: [], empty: true },
    )
    expect(empty).toMatchObject({
      tone: 'good',
      blocks: [{ type: 'text', text: 'Nothing new needs attention.' }],
    })
  })
})

test('presets are valid digests once given a scope', () => {
  for (const preset of digestPresets)
    expect(digestInputSchema.safeParse({ ...preset.input, scope: { all: true } }).success).toBe(
      true,
    )
})

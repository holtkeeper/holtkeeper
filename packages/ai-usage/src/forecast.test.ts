import { describe, expect, test } from 'bun:test'

import type { NewAiUsageRecord } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { spendForecast } from './forecast.ts'
import { weekDays, weekRange } from './period.ts'

const spend = (
  at: string,
  costUsd: number,
  overrides: Partial<NewAiUsageRecord> = {},
): NewAiUsageRecord => ({
  at,
  repo: { forge: 'work', path: 'games/app' },
  groups: ['games'],
  taskKind: 'review',
  actor: 'system',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: 'reported',
  durationMs: 10,
  turns: 1,
  outcome: 'ok',
  ...overrides,
})

const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0)

describe('spendForecast per day', () => {
  const now = new Date('2026-11-12T12:00:00.000Z')

  test('each remaining day is the mean of that day over the counted weeks', async () => {
    const store = memoryStore()
    const records = [
      spend('2026-11-10T08:00:00.000Z', 5),
      spend('2026-11-05T06:00:00.000Z', 50),
      spend('2026-11-05T18:00:00.000Z', 4),
      spend('2026-11-07T08:00:00.000Z', 8),
      spend('2026-11-08T10:00:00.000Z', 2, { interactive: true, actor: 'jane' }),
      spend('2026-10-30T08:00:00.000Z', 6),
    ]
    await Promise.all(records.map((record) => store.aiUsage.append(record)))
    const forecast = await spendForecast(store.aiUsage, now, { timeZone: 'UTC', perDay: true })
    expect(forecast).toMatchObject({ spentUsd: 5, forecastUsd: 15, weeks: 2 })
    expect(forecast.days).toEqual([
      { day: '2026-11-12', usd: 2, automaticUsd: 2 },
      { day: '2026-11-13', usd: 3, automaticUsd: 3 },
      { day: '2026-11-14', usd: 4, automaticUsd: 4 },
      { day: '2026-11-15', usd: 1, automaticUsd: 0 },
    ])
    const days = forecast.days ?? []
    expect(total(days.map((day) => day.usd))).toBe(forecast.forecastUsd - forecast.spentUsd)
    expect(total(days.map((day) => day.automaticUsd))).toBe(
      forecast.automaticForecastUsd - forecast.automaticUsd,
    )
  })

  test('without history the extended pace is spread by what is left of each day', async () => {
    const store = memoryStore()
    await store.aiUsage.append(spend('2026-11-10T08:00:00.000Z', 7))
    const forecast = await spendForecast(store.aiUsage, now, { timeZone: 'UTC', perDay: true })
    expect(forecast).toMatchObject({ forecastUsd: 14, weeks: 0 })
    expect(forecast.days?.map((day) => [day.day, day.usd])).toEqual([
      ['2026-11-12', 1],
      ['2026-11-13', 2],
      ['2026-11-14', 2],
      ['2026-11-15', 2],
    ])
  })

  test('days are left out unless asked for', async () => {
    const forecast = await spendForecast(memoryStore().aiUsage, now, { timeZone: 'UTC' })
    expect(forecast.days).toBeUndefined()
  })

  test('a day with a clock change keeps its real length and the days still add up', async () => {
    const store = memoryStore()
    await store.aiUsage.append(spend('2026-10-20T08:00:00.000Z', 9))
    const at = new Date('2026-10-24T10:00:00.000Z')
    const forecast = await spendForecast(store.aiUsage, at, {
      timeZone: 'Europe/Berlin',
      perDay: true,
    })
    expect(forecast.days?.map((day) => day.day)).toEqual(['2026-10-24', '2026-10-25'])
    const days = forecast.days ?? []
    expect(total(days.map((day) => day.usd))).toBeCloseTo(forecast.forecastUsd - 9, 10)
    expect(days[1]!.usd / days[0]!.usd).toBeCloseTo(25 / 12, 10)
  })
})

test('weekDays covers the week with local days, a 25-hour one when clocks go back', () => {
  const week = weekRange(new Date('2026-10-24T10:00:00.000Z'), 'Europe/Berlin')
  const days = weekDays(week, 'Europe/Berlin')
  expect(days[0]?.from).toBe(week.from)
  expect(days.at(-1)?.to).toBe(week.to)
  expect(days.map((day) => day.key)).toEqual([
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
  ])
  expect(days.at(-1)).toMatchObject({
    from: '2026-10-24T22:00:00.000Z',
    to: '2026-10-25T23:00:00.000Z',
  })
  for (const [index, day] of days.entries()) if (index) expect(day.from).toBe(days[index - 1]!.to)
})

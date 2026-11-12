import { describe, expect, test } from 'bun:test'

import type { ForgeDefinition } from '@holtkeeper/forge'

import {
  ConfigError,
  groupLabel,
  groupPathLabel,
  groupTitle,
  loadConfig,
  looksLikeCron,
  parseConfig,
  parseConfigFile,
  rootGroups,
  subgroupsOf,
} from './config.ts'
import { resolveRepo } from './resolve.ts'

const forge: ForgeDefinition = {
  kind: 'fake',
  url: 'https://forge.test',
  create: () => {
    throw new Error('not used')
  },
}

const base = {
  forges: { work: forge },
  groups: {
    games: { forge: 'work', include: ['games/*'], exclude: ['games/legacy-*'] },
    tools: { forge: 'work', include: ['tools/**'] },
  },
}

const errorOf = (input: unknown) => {
  try {
    parseConfig(input)
  } catch (error) {
    if (error instanceof ConfigError) return error.message
    throw error
  }
  throw new Error('expected config to be invalid')
}

describe('parseConfig', () => {
  test('applies defaults', () => {
    const config = parseConfig({ forges: { work: forge } })
    expect(config).toMatchObject({ dryRun: false, groups: {}, repos: {} })
    expect(config.jobs.schedules).toEqual([])
    expect(parseConfig({}).forges).toEqual({})
  })

  test('trims group titles and rejects empty or long ones', () => {
    const group = { forge: 'work', include: ['games/*'] }
    const config = parseConfig({
      forges: { work: forge },
      groups: { games: { ...group, title: '  Game studio ' } },
    })
    expect(config.groups.games?.title).toBe('Game studio')
    expect(
      errorOf({ forges: { work: forge }, groups: { games: { ...group, title: ' ' } } }),
    ).toContain('groups.games.title')
    expect(
      errorOf({ forges: { work: forge }, groups: { games: { ...group, title: 'x'.repeat(61) } } }),
    ).toContain('groups.games.title')
  })

  test('rejects unknown forge in a group', () => {
    expect(
      errorOf({ forges: { work: forge }, groups: { games: { forge: 'nope', include: ['*'] } } }),
    ).toContain('unknown forge "nope"')
  })

  test('rejects values that are not forges and unknown groups', () => {
    expect(errorOf({ forges: { work: {} } })).toContain('expected a forge')
    expect(
      errorOf({ ...base, jobs: { onTag: { analyzers: ['x'], groups: [['games', 'gone']] } } }),
    ).toContain('unknown group "gone"')
  })

  test('accepts subgroups one level deep under a configured parent', () => {
    const round = { forge: 'work', include: ['games/round-*'] }
    const config = parseConfig({ ...base, groups: { ...base.groups, 'games.round': round } })
    expect(rootGroups(config)).toEqual(['games', 'tools'])
    expect(subgroupsOf(config, 'games')).toEqual(['games.round'])
    expect(subgroupsOf(config, 'tools')).toEqual([])
    expect(errorOf({ ...base, groups: { ...base.groups, 'games.round.small': round } })).toContain(
      'groups["games.round.small"]',
    )
    expect(errorOf({ ...base, groups: { ...base.groups, Games: round } })).toContain('groups.Games')
  })

  test('rejects a subgroup without its parent or on another forge', () => {
    const round = { forge: 'work', include: ['shapes/round-*'] }
    expect(errorOf({ ...base, groups: { ...base.groups, 'shapes.round': round } })).toContain(
      'parent group "shapes" is not configured',
    )
    expect(
      errorOf({
        forges: { work: forge, other: forge },
        groups: { ...base.groups, 'games.round': { ...round, forge: 'other' } },
      }),
    ).toContain('forge must match parent "games"')
  })

  test('accepts AI provider plugins once each', () => {
    const acme = { package: 'acme-ai-provider', languageModel: () => ({}) }
    expect(errorOf({ ...base, ai: { providers: [acme, acme] } })).toEqual(
      expect.stringContaining('AI provider "acme-ai-provider" is added twice'),
    )
    expect(errorOf({ ...base, ai: { providers: [{}] } })).toContain(
      'expected an AI provider plugin',
    )
  })
})

describe('resolveRepo', () => {
  const config = parseConfig({
    ...base,
    repos: {
      'games/*': { traits: { ssr: false, runtime: 'browser' } },
      'games/app-x': { traits: { ssr: true } },
    },
  })

  test('collects groups and traits', () => {
    const resolved = resolveRepo(config, { forge: 'work', path: 'games/app-x' })
    expect(resolved.groups).toEqual(['games'])
    expect(resolved.traits).toEqual({ ssr: true, runtime: 'browser' })
  })

  test('respects group excludes', () => {
    expect(resolveRepo(config, { forge: 'work', path: 'games/legacy-a' }).groups).toEqual([])
  })

  test('matches nested paths only with globstar', () => {
    expect(resolveRepo(config, { forge: 'work', path: 'games/a/b' }).groups).toEqual([])
    expect(resolveRepo(config, { forge: 'work', path: 'tools/a/b' }).groups).toEqual(['tools'])
  })

  test('ignores repositories from other forges', () => {
    expect(resolveRepo(config, { forge: 'other', path: 'games/app-x' })).toMatchObject({
      groups: [],
      traits: {},
    })
  })
})

describe('loadConfig', () => {
  test('reports a missing file', async () => {
    expect(loadConfig('does-not-exist.config.ts')).rejects.toThrow('config not found')
  })
})

describe('parseConfigFile', () => {
  test('keeps infrastructure and always has a jobs section', () => {
    const config = parseConfigFile({ limits: { distributed: true } }, { warn: () => {} })
    expect(config).toEqual({
      dryRun: false,
      jobs: { concurrency: 2, cacheDir: '.holtkeeper/cache', timeoutMinutes: 30 },
      limits: { distributed: true },
    })
  })

  test('warns once per removed key and ignores it', () => {
    const warnings: string[] = []
    const config = parseConfigFile(
      {
        forges: { work: forge },
        groups: {},
        jobs: {
          concurrency: 3,
          schedules: [],
          onTag: { analyzers: ['x'] },
          botUsername: 'bot',
          webhookSecret: 's',
        },
      },
      { warn: (line) => warnings.push(line) },
    )
    expect(warnings).toHaveLength(5)
    expect(warnings[0]).toContain('`forges` is no longer read from the config file')
    expect(warnings.some((line) => line.includes('`jobs.botUsername`'))).toBeTrue()
    expect(config).not.toHaveProperty('forges')
    expect(config.jobs).toEqual({
      concurrency: 3,
      cacheDir: '.holtkeeper/cache',
      timeoutMinutes: 30,
      webhookSecret: 's',
    })
  })

  test('rejects invalid infrastructure', () => {
    expect(() => parseConfigFile({ jobs: { concurrency: 0 } }, { warn: () => {} })).toThrow(
      ConfigError,
    )
  })
})

describe('jobs config', () => {
  test('applies defaults', () => {
    const config = parseConfig({ ...base, jobs: {} })
    expect(config.jobs).toEqual({
      concurrency: 2,
      cacheDir: '.holtkeeper/cache',
      timeoutMinutes: 30,
      schedules: [],
    })
  })

  test('accepts schedules, onTag and a webhook secret', () => {
    const config = parseConfig({
      ...base,
      jobs: {
        schedules: [
          {
            name: 'nightly',
            cron: '0 3 * * 1-5',
            analyzers: ['depgraph'],
            groups: ['games'],
            repos: ['work:games/*'],
            options: { depgraph: { depth: 2 } },
          },
          { name: 'weekly', cron: '@weekly', analyzers: ['quality'] },
        ],
        onTag: { analyzers: ['changelog'], groups: ['games'] },
        webhookSecret: { env: 'HOOK_SECRET' },
      },
    })
    expect(config.jobs?.schedules.map((s) => s.name)).toEqual(['nightly', 'weekly'])
  })

  test('rejects bad cron, unknown groups and forges, duplicate names', () => {
    const message = errorOf({
      ...base,
      jobs: {
        schedules: [
          { name: 'a', cron: 'every day', analyzers: ['x'] },
          { name: 'a', cron: '* * * * *', analyzers: ['x'], groups: ['nope'], repos: ['zz:a/*'] },
        ],
        onTag: { analyzers: ['x'], groups: ['missing'] },
      },
    })
    expect(message).toContain('expected a cron expression')
    expect(message).toContain('schedule "a" is defined twice')
    expect(message).toContain('unknown group "nope"')
    expect(message).toContain('unknown forge "zz"')
    expect(message).toContain('unknown group "missing"')
  })

  test('smart schedules: every or cron, windows, time zone', () => {
    const config = parseConfig({
      ...base,
      jobs: {
        schedules: [
          {
            name: 'office',
            every: '1h',
            timezone: 'Europe/Berlin',
            windows: {
              allow: [{ days: ['mon', 'fri'], from: '09:00', to: '18:00' }],
              skipNights: { from: '22:00', to: '06:00' },
              holidays: ['2026-12-24'],
            },
            jitterMinutes: 5,
            spread: true,
            analyzers: ['quality'],
          },
        ],
      },
    })
    expect(config.jobs?.schedules[0]?.enabled).toBeTrue()
    const message = errorOf({
      ...base,
      jobs: {
        schedules: [
          { name: 'a', analyzers: ['x'] },
          { name: 'b', every: '5x', cron: '0 * * * *', analyzers: ['x'], timezone: 'Mars/Base' },
          {
            name: 'c',
            every: '1h',
            analyzers: ['x'],
            windows: { allow: [{ days: ['mon'], from: '25:00', to: '10:00' }] },
          },
        ],
      },
    })
    expect(message).toContain('set exactly one of cron and every')
    expect(message).toContain('expected an interval')
    expect(message).toContain('expected an IANA time zone')
    expect(message).toContain('expected HH:MM')
  })

  test('looksLikeCron', () => {
    expect(looksLikeCron('*/15 * * * *')).toBeTrue()
    expect(looksLikeCron('0 0 3 * * MON-FRI')).toBeTrue()
    expect(looksLikeCron('@daily')).toBeTrue()
    expect(looksLikeCron('* * *')).toBeFalse()
    expect(looksLikeCron('rm -rf * * * *')).toBeFalse()
  })
})

describe('group titles', () => {
  const groups = { games: { title: 'Game studio' }, tools: {}, same: { title: 'same' } }

  test('groupTitle shows the title, else the key', () => {
    expect(groupTitle(groups, 'games')).toBe('Game studio')
    expect(groupTitle(groups, 'tools')).toBe('tools')
    expect(groupTitle(groups, 'gone')).toBe('gone')
  })

  test('groupLabel keeps the key next to the title', () => {
    expect(groupLabel(groups, 'games')).toBe('Game studio (games)')
    expect(groupLabel(groups, 'tools')).toBe('tools')
    expect(groupLabel(groups, 'same')).toBe('same')
    expect(groupLabel(groups, 'gone')).toBe('gone')
  })

  test('groupPathLabel shows a subgroup under its parent', () => {
    const titled = {
      shapes: { title: 'Shapes' },
      'shapes.round': { title: 'Round' },
      'shapes.flat': {},
    }
    expect(groupPathLabel(titled, 'shapes.round')).toBe('Shapes › Round (shapes.round)')
    expect(groupPathLabel(titled, 'shapes.flat')).toBe('Shapes › shapes.flat (shapes.flat)')
    expect(groupPathLabel(titled, 'shapes')).toBe('Shapes (shapes)')
    expect(groupPathLabel({}, 'tools')).toBe('tools')
    expect(groupLabel(titled, 'shapes.round')).toBe('Shapes › Round (shapes.round)')
  })
})

import { describe, expect, test } from 'bun:test'

import type { ForgeDefinition } from '@holtkeeper/forge'

import {
  ConfigError,
  loadConfig,
  looksLikeCron,
  parseConfig,
  fleetPatterns,
  parseConfigFile,
  teamLabel,
  teamTitle,
} from './config.ts'

const forge: ForgeDefinition = {
  kind: 'fake',
  url: 'https://forge.test',
  create: () => {
    throw new Error('not used')
  },
}

const base = {
  forges: { work: forge },
  teams: {
    games: { owns: ['work:games/*'], exclude: ['games/legacy-*'] },
    tools: { owns: ['tools/**'] },
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
    expect(config).toMatchObject({ dryRun: false, teams: {}, repos: {} })
    expect(config.jobs.schedules).toEqual([])
    expect(parseConfig({}).forges).toEqual({})
  })

  test('trims team titles and rejects empty or long ones', () => {
    const team = { owns: ['games/*'] }
    const config = parseConfig({
      forges: { work: forge },
      teams: { games: { ...team, title: '  Game studio ' } },
    })
    expect(config.teams.games?.title).toBe('Game studio')
    expect(config.teams.games).toMatchObject({ exclude: [], consumes: [], members: [] })
    expect(
      errorOf({ forges: { work: forge }, teams: { games: { ...team, title: ' ' } } }),
    ).toContain('teams.games.title')
    expect(
      errorOf({ forges: { work: forge }, teams: { games: { ...team, title: 'x'.repeat(61) } } }),
    ).toContain('teams.games.title')
  })

  test('rejects unknown forges in team patterns, bad keys and empty teams', () => {
    expect(
      errorOf({ forges: { work: forge }, teams: { games: { owns: ['nope:games/*'] } } }),
    ).toContain('unknown forge "nope"')
    expect(
      errorOf({ forges: { work: forge }, teams: { games: { owns: ['a/*'], consumes: ['zz:b'] } } }),
    ).toContain('unknown forge "zz"')
    expect(errorOf({ teams: { 'games.round': { owns: ['a/*'] } } })).toContain('teams')
    expect(errorOf({ teams: { games: { owns: [] } } })).toContain('teams.games.owns')
    expect(errorOf({ teams: { games: { owns: ['**/web'] } } })).toContain(
      'must start with a namespace',
    )
    expect(errorOf({ teams: { games: { owns: ['a/*'], consumes: ['*'] } } })).toContain(
      'teams.games.consumes',
    )
    expect(
      errorOf({ forges: { work: forge }, fleet: { work: { include: ['work:*/web'] } } }),
    ).toContain('fleet.work.include')
  })

  test('validates members', () => {
    const config = parseConfig({
      teams: { games: { owns: ['a/*'], members: [{ id: 'ada', role: 'maintainer' }] } },
    })
    expect(config.teams.games?.members).toEqual([{ id: 'ada', role: 'maintainer' }])
    expect(
      errorOf({ teams: { games: { owns: ['a/*'], members: [{ id: 'ada', role: 'owner' }] } } }),
    ).toContain('teams.games.members')
  })

  test('rejects values that are not forges and unknown teams', () => {
    expect(errorOf({ forges: { work: {} } })).toContain('expected a forge')
    expect(
      errorOf({ ...base, jobs: { onTag: { analyzers: ['x'], teams: ['games', 'gone'] } } }),
    ).toContain('unknown team "gone"')
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
        teams: {},
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
    expect(warnings).toHaveLength(6)
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
            teams: ['games'],
            repos: ['work:games/*'],
            options: { depgraph: { depth: 2 } },
          },
          { name: 'weekly', cron: '@weekly', analyzers: ['quality'] },
        ],
        onTag: { analyzers: ['changelog'], teams: ['games'], repos: ['tools/*'] },
        webhookSecret: { env: 'HOOK_SECRET' },
      },
    })
    expect(config.jobs?.schedules.map((s) => s.name)).toEqual(['nightly', 'weekly'])
  })

  test('rejects bad cron, unknown teams and forges, duplicate names', () => {
    const message = errorOf({
      ...base,
      jobs: {
        schedules: [
          { name: 'a', cron: 'every day', analyzers: ['x'] },
          { name: 'a', cron: '* * * * *', analyzers: ['x'], teams: ['nope'], repos: ['zz:a/*'] },
        ],
        onTag: { analyzers: ['x'], teams: ['missing'], repos: ['yy:b/*'] },
      },
    })
    expect(message).toContain('expected a cron expression')
    expect(message).toContain('schedule "a" is defined twice')
    expect(message).toContain('unknown team "nope"')
    expect(message).toContain('unknown forge "zz"')
    expect(message).toContain('unknown team "missing"')
    expect(message).toContain('unknown forge "yy"')
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

describe('fleetPatterns', () => {
  test('joins the forge includes with the patterns teams own and consume there', () => {
    const config = parseConfig({
      forges: { work: forge, home: forge },
      fleet: { work: { include: ['misc/*'], exclude: ['misc/old'] } },
      teams: {
        games: { owns: ['work:games/*', 'shared/**'], consumes: ['home:lib/*'] },
      },
    })
    expect(fleetPatterns(config, 'work')).toEqual({
      include: ['misc/*', 'games/*', 'shared/**'],
      exclude: ['misc/old'],
    })
    expect(fleetPatterns(config, 'home')).toEqual({ include: ['shared/**', 'lib/*'], exclude: [] })
    expect(errorOf({ fleet: { gone: { include: ['a/*'] } } })).toContain('unknown forge "gone"')
  })
})

describe('team titles', () => {
  const teams = { games: { title: 'Game studio' }, tools: {}, same: { title: 'same' } }

  test('teamTitle shows the title, else the key', () => {
    expect(teamTitle(teams, 'games')).toBe('Game studio')
    expect(teamTitle(teams, 'tools')).toBe('tools')
    expect(teamTitle(teams, 'gone')).toBe('gone')
  })

  test('teamLabel keeps the key next to the title', () => {
    expect(teamLabel(teams, 'games')).toBe('Game studio (games)')
    expect(teamLabel(teams, 'tools')).toBe('tools')
    expect(teamLabel(teams, 'same')).toBe('same')
    expect(teamLabel(teams, 'gone')).toBe('gone')
  })
})

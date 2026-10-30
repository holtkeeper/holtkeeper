import { describe, expect, test } from 'bun:test'

import type { ForgeDefinition } from '@holtkeeper/forge'
import { z } from 'zod'

import { ConfigError, loadConfig, looksLikeCron, parseConfig } from './config.ts'
import { definePlugin } from './plugin.ts'
import { resolveRepo } from './resolve.ts'

const forge: ForgeDefinition = {
  kind: 'fake',
  url: 'https://forge.test',
  create: () => {
    throw new Error('not used')
  },
}

const greeter = definePlugin({
  name: 'greeter',
  options: z.object({ greeting: z.string().default('hello'), loud: z.boolean().default(false) }),
  run: async () => {},
})

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
    expect(config).toMatchObject({ dryRun: false, groups: {}, repos: {}, plugins: [] })
  })

  test('rejects unknown forge in a group', () => {
    expect(
      errorOf({ forges: { work: forge }, groups: { games: { forge: 'nope', include: ['*'] } } }),
    ).toContain('unknown forge "nope"')
  })

  test('rejects values that are not forges or plugins', () => {
    const message = errorOf({ forges: { work: {} }, plugins: [{}] })
    expect(message).toContain('expected a forge')
    expect(message).toContain('expected a plugin')
  })

  test('rejects unknown groups and duplicate plugins', () => {
    const message = errorOf({
      ...base,
      plugins: [greeter({ groups: ['games'] }), greeter({ groups: ['nope'] })],
    })
    expect(message).toContain('plugin "greeter" is used twice')
    expect(message).toContain('unknown group "nope"')
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

  test('validates plugin options and overrides', () => {
    const message = errorOf({
      ...base,
      plugins: [
        {
          plugin: greeter({ groups: [] }).plugin,
          groups: ['games'],
          options: { greeting: 1 },
          overrides: { 'games/x': { loud: 'yes' } },
        },
      ],
    })
    expect(message).toContain('plugins[0].options.greeting')
    expect(message).toContain('plugins[0].overrides["games/x"].loud')
  })
})

describe('resolveRepo', () => {
  const config = parseConfig({
    ...base,
    repos: {
      'games/*': { traits: { ssr: false, runtime: 'browser' } },
      'games/slots-x': { traits: { ssr: true } },
    },
    plugins: [
      greeter({
        groups: ['games'],
        exclude: ['games/skip-me'],
        options: { greeting: 'hi' },
        overrides: { 'games/slots-*': { loud: true } },
      }),
    ],
  })

  test('collects groups, traits and plugin options', () => {
    const resolved = resolveRepo(config, { forge: 'work', path: 'games/slots-x' })
    expect(resolved.groups).toEqual(['games'])
    expect(resolved.traits).toEqual({ ssr: true, runtime: 'browser' })
    expect(resolved.plugins.map((p) => [p.plugin.name, p.options])).toEqual([
      ['greeter', { greeting: 'hi', loud: true }],
    ])
  })

  test('respects group and plugin excludes', () => {
    expect(resolveRepo(config, { forge: 'work', path: 'games/legacy-a' }).groups).toEqual([])
    expect(resolveRepo(config, { forge: 'work', path: 'games/skip-me' }).plugins).toEqual([])
  })

  test('matches nested paths only with globstar', () => {
    expect(resolveRepo(config, { forge: 'work', path: 'games/a/b' }).groups).toEqual([])
    expect(resolveRepo(config, { forge: 'work', path: 'tools/a/b' }).groups).toEqual(['tools'])
  })

  test('ignores repositories from other forges', () => {
    expect(resolveRepo(config, { forge: 'other', path: 'games/slots-x' })).toMatchObject({
      groups: [],
      traits: {},
      plugins: [],
    })
  })
})

describe('loadConfig', () => {
  test('reports a missing file', async () => {
    expect(loadConfig('does-not-exist.config.ts')).rejects.toThrow('config not found')
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

  test('smart schedules: every or cron, windows, time zone; per-forge webhooks', () => {
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
        webhooks: { nowhere: { secret: 's' } },
      },
    })
    expect(message).toContain('set exactly one of cron and every')
    expect(message).toContain('expected an interval')
    expect(message).toContain('expected an IANA time zone')
    expect(message).toContain('expected HH:MM')
    expect(message).toContain('unknown forge "nowhere"')
  })

  test('looksLikeCron', () => {
    expect(looksLikeCron('*/15 * * * *')).toBeTrue()
    expect(looksLikeCron('0 0 3 * * MON-FRI')).toBeTrue()
    expect(looksLikeCron('@daily')).toBeTrue()
    expect(looksLikeCron('* * *')).toBeFalse()
    expect(looksLikeCron('rm -rf * * * *')).toBeFalse()
  })
})

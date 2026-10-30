import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  i18nAnalysis,
  i18nAnalyzer,
  i18nDataSchema,
  i18nOptions,
  requiredCheckouts,
} from '../src/index.ts'
import type { I18nData } from '../src/index.ts'
import { applied, project } from './fixtures.ts'

const translationsRepo = { forge: 'work', path: 'i18n/translations' }

const layers = [
  {
    id: 'common',
    repo: 'work:i18n/translations',
    ref: 'main',
    files: 'common/{locale}/{namespace}.json',
  },
  {
    id: 'game',
    repo: 'work:i18n/translations',
    ref: 'main',
    files: 'games/{repoName}/{locale}/{namespace}.json',
  },
  { id: 'local', files: 'src/locales/{locale}.json', namespace: 'game' },
]
const write = [
  { namespaces: ['ui'], layer: 'common' },
  { keys: ['local.*'], layer: 'local' },
  { layer: 'game' },
]

let shared: Awaited<ReturnType<typeof project>>
let slots: Awaited<ReturnType<typeof project>>
let poker: Awaited<ReturnType<typeof project>>

beforeAll(async () => {
  shared = await project({
    'common/en/ui.json': { ok: 'OK', cancel: 'Cancel', spin: 'Spin the reels', title: 'Casino' },
    'common/ru/ui.json': { ok: 'ОК', cancel: 'Отмена', title: 'Казино' },
    'games/slots-x/en/ui.json': { title: 'Slots X' },
    'games/slots-x/ru/ui.json': { title: 'Слоты X' },
    'games/slots-x/en/game.json': { reels: 'Reels', bonus: 'Bonus round', legacy: 'Old screen' },
    'games/slots-x/ru/game.json': { reels: 'Барабаны', legacy: 'Старый экран' },
    'games/poker/en/game.json': { fold: 'Fold the hand' },
    'games/poker/ru/game.json': {},
  })
  slots = await project({
    'src/locales/en.json': { local: { banner: 'Play now for free' } },
    'src/locales/ru.json': {},
    'src/App.tsx': [
      "t('ui:ok')",
      "t('ui:title')",
      "t('ui:spin')",
      "t('game:reels')",
      "t('game:bonus')",
      "t('game:local.banner')",
    ].join('\n'),
  })
  poker = await project({ 'src/Table.tsx': "t('game:fold')\nt('ui:ok')\n" })
})
afterAll(async () => {
  await Promise.all([shared.cleanup(), slots.cleanup(), poker.cleanup()])
})

const run = async (repoPath: string, dir: string) => {
  const repo = { forge: 'work', path: repoPath }
  const options = i18nOptions.parse({
    mode: 'suggest',
    layers,
    write,
    __checkouts: `work:i18n/translations=${shared.dir}`,
  })
  expect(requiredCheckouts(options, repo)).toEqual([{ repo: translationsRepo, ref: 'main' }])
  return (await i18nAnalyzer.run({ repo, dir, runner: undefined as never, options })).data
}

describe('layered catalogs', () => {
  let data: I18nData
  beforeAll(async () => {
    data = await run('games/slots-x', slots.dir)
  })

  test('merges layers in order and records provenance', () => {
    expect(i18nDataSchema.safeParse(data).success).toBe(true)
    expect(data.layers.map((l) => [l.id, l.shared, l.catalogs, l.repo?.path])).toEqual([
      ['common', true, 2, 'i18n/translations'],
      ['game', false, 4, 'i18n/translations'],
      ['local', false, 2, undefined],
    ])
    expect(data.bundles.map((b) => b.id)).toEqual(['game', 'ui'])
    expect(data.provenance.find((p) => p.key === 'title')).toEqual({
      bundle: 'ui',
      key: 'title',
      layer: 'game',
      layers: ['common', 'game'],
    })
    expect(data.provenance.find((p) => p.key === 'ok')?.layer).toBe('common')
    expect(
      data.overrides
        .map((o) => `${o.locale}:${o.key}:${o.layer}>${o.overrides.join(',')}`)
        .toSorted(),
    ).toEqual(['en:title:game>common', 'ru:title:game>common'])
    expect(data.untranslated).toEqual([])
  })

  test('routes missing keys by the write rules', () => {
    expect(data.missing.map((m) => `${m.bundle}:${m.key}:${m.layer}:${m.file}`).toSorted()).toEqual(
      [
        'game:bonus:game:games/slots-x/ru/game.json',
        'game:local.banner:local:src/locales/ru.json',
        'ui:spin:common:common/ru/ui.json',
      ],
    )
  })

  test('shared keys this game does not use are informational, its own are removable', async () => {
    expect(data.usage.unused).toEqual([
      { bundle: 'game', key: 'legacy', layer: 'game', shared: false },
      { bundle: 'ui', key: 'cancel', layer: 'common', shared: true },
    ])
    expect(data.usage.missingInBase).toEqual([])
    const removal = data.changes.filter((c) => c.id.startsWith('i18n:unused:'))
    expect(removal.map((c) => [c.id, c.target, c.edits.map((e) => e.file).toSorted()])).toEqual([
      [
        'i18n:unused:work:i18n/translations:game',
        translationsRepo,
        ['games/slots-x/en/game.json', 'games/slots-x/ru/game.json'],
      ],
    ])
    const { files } = await applied(shared.dir, removal)
    expect(JSON.parse(files.get('games/slots-x/en/game.json')!)).toEqual({
      reels: 'Reels',
      bonus: 'Bonus round',
    })
  })

  test('changes target the layer repository with repo-relative paths', async () => {
    const added = data.changes.filter((c) => c.id.startsWith('i18n:missing:'))
    const byFile = new Map(added.map((c) => [c.edits[0]!.file, c]))
    expect([...byFile.keys()].toSorted()).toEqual([
      'common/ru/ui.json',
      'games/slots-x/ru/game.json',
      'src/locales/ru.json',
    ])
    expect(byFile.get('common/ru/ui.json')?.target).toEqual(translationsRepo)
    expect(byFile.get('games/slots-x/ru/game.json')?.target).toEqual(translationsRepo)
    expect(byFile.get('src/locales/ru.json')?.target).toBeUndefined()

    const external = added.filter((c) => c.target)
    const { plan, files } = await applied(shared.dir, external)
    expect(plan.conflicts).toEqual([])
    expect(JSON.parse(files.get('common/ru/ui.json')!)).toEqual({
      ok: 'ОК',
      cancel: 'Отмена',
      title: 'Казино',
      spin: 'TODO: Spin the reels',
    })
    expect(files.get('games/slots-x/ru/game.json')).toBe(
      '{\n  "reels": "Барабаны",\n  "bonus": "TODO: Bonus round",\n  "legacy": "Старый экран"\n}\n',
    )
    const local = await applied(
      slots.dir,
      added.filter((c) => !c.target),
    )
    expect(JSON.parse(local.files.get('src/locales/ru.json')!)).toEqual({
      local: { banner: 'TODO: Play now for free' },
    })
  })

  test('another game sees its own folder over the same common layer', async () => {
    const other = await run('games/poker', poker.dir)
    expect(other.missing.map((m) => `${m.key}:${m.file}`).toSorted()).toEqual([
      'fold:games/poker/ru/game.json',
      'spin:common/ru/ui.json',
    ])
    expect(other.provenance.find((p) => p.key === 'title')?.layer).toBe('common')
    expect(
      other.changes.find((c) => c.edits[0]?.file === 'games/poker/ru/game.json')?.target,
    ).toEqual(translationsRepo)
    expect(other.usage.unused.map((u) => `${u.key}:${u.shared}`).toSorted()).toEqual([
      'cancel:true',
      'spin:true',
      'title:true',
    ])
  })

  test('the report shows layers, overrides and shared unused keys', () => {
    const record = {
      id: '1',
      repo: { forge: 'work', path: 'games/slots-x' },
      kind: 'i18n',
      createdAt: '2026-10-30T00:00:00Z',
      data,
    }
    const report = i18nAnalysis.toReport(record)
    expect(report.sections.map((s) => s.id)).toEqual([
      'completeness',
      'layers',
      'missing',
      'usage',
      'changes',
    ])
    const layersSection = report.sections.find((s) => s.id === 'layers')!
    expect(
      layersSection.blocks.some((b) => b.type === 'issues' && b.items[0]?.tone === 'info'),
    ).toBe(true)
    expect(report.metrics.find((m) => m.id === 'unused')).toMatchObject({
      value: 1,
      hint: '1 more in shared layers',
    })
  })

  test('a missing checkout is an error', async () => {
    const options = i18nOptions.parse({ layers, write })
    const error = await i18nAnalyzer
      .run({
        repo: { forge: 'work', path: 'games/slots-x' },
        dir: slots.dir,
        runner: undefined as never,
        options,
      })
      .catch((caught: unknown) => caught)
    expect(String(error)).toContain('needs a checkout of work:i18n/translations')
  })
})

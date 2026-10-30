import { describe, expect, test } from 'bun:test'

import {
  fakeDocuments,
  fakeForge,
  featureFlags,
  flagsPage,
  forgeFiles,
  gameRepos,
} from '../test/fixtures.ts'
import type { TrackerDefinitionInput } from './definition.ts'
import { runTracker } from './engine.ts'

const now = new Date('2026-10-30T12:00:00Z')

const run = (definition = featureFlags, files = forgeFiles) => {
  const forge = fakeForge(files)
  const documents = fakeDocuments([flagsPage])
  return {
    forge,
    documents,
    data: runTracker(definition, {
      forge,
      forgeId: 'work',
      repos: gameRepos,
      group: 'games',
      documents: { confluence: documents },
      now,
    }),
  }
}

describe('runTracker on the feature-flag case', () => {
  test('merges definitions, usages, Helm values and the wiki table into entities', async () => {
    const { data: pending, forge, documents } = run()
    const data = await pending
    expect(data.generatedAt).toBe(now.toISOString())
    expect(data.errors).toEqual([])
    expect(data.entities.map((entity) => entity.key)).toEqual([
      'ghost_flag',
      'legacy_widget',
      'new_hub',
      'old_tables',
      'removed_flag',
      'turbo_mode',
    ])
    const hub = data.entities.find((entity) => entity.key === 'new_hub')!
    expect(hub.attrs.default?.value).toBe('false')
    expect(hub.attrs.description?.value).toBe('Redesigned hub')
    expect(hub.attrs.owner?.value).toBe('@abc')
    expect(hub.environments).toEqual({ prod: { value: 'false' }, dev: { value: 'true' } })
    expect(
      hub.occurrences
        .filter((occurrence) => occurrence.role === 'usage')
        .map((occurrence) => `${occurrence.repo}/${occurrence.file}:${occurrence.line}`),
    ).toEqual(['games/adventure/src/board.tsx:1', 'games/app/src/hub.ts:1'])
    expect(
      hub.occurrences.find((occurrence) => occurrence.role === 'documentation')?.document,
    ).toEqual({
      provider: 'confluence',
      ref: '12345',
      title: 'Feature flags',
      url: 'https://wiki.example.com/pages/12345',
    })
    expect(forge.reads).not.toContain('infra/helm/charts/adventure/Chart.yaml')
    expect(forge.reads).toContain('infra/helm/charts/app/values-prod.yaml')
    expect(documents.reads).toEqual(['12345'])
    expect(data.sourcesRead.find((read) => read.source === 'helm')).toMatchObject({
      repo: 'infra/helm',
      files: 3,
      extracted: 6,
    })
  })

  test('applies every rule', async () => {
    const data = await run().data
    expect(data.findings.map((finding) => finding.id).toSorted()).toEqual([
      'attribute-mismatch:turbo_mode:prod',
      'documented-missing:legacy_widget',
      'stale-config:removed_flag',
      'undefined:ghost_flag',
      'undocumented:old_tables',
      'undocumented:turbo_mode',
      'unused:old_tables',
    ])
  })

  test('plans publications and repository changes without writing', async () => {
    const data = await run().data
    const section = data.publications.find((publication) => publication.output === 'wiki-section')
    expect(section).toMatchObject({
      provider: 'confluence',
      ref: '12345',
      markerId: 'holtkeeper:flags',
      format: 'storage',
      expectedVersion: 7,
    })
    expect(section?.content).toStartWith('<h2>Flag inventory</h2><table>')
    expect(section?.content).toContain(
      '<tr><td>new_hub</td><td>Redesigned hub</td><td>@abc</td><td>games/adventure, games/app</td><td>false</td></tr>',
    )
    expect(
      data.publications.find((publication) => publication.output === 'chat')?.content,
    ).toStartWith('Feature flags\n6 feature flags tracked, 7 findings')
    expect(data.changes).toHaveLength(1)
    const [change] = data.changes
    expect(change?.target).toEqual({ forge: 'work', path: 'infra/helm' })
    expect(change?.id).toBe('tracker:feature-flags:helm-doc:infra/helm:docs/flags.md')
    const edit = change?.edits[0]
    expect(edit).toMatchObject({
      kind: 'replace',
      file: 'docs/flags.md',
      oldText: 'old\n',
      range: { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } },
    })
    const text = edit?.kind === 'replace' ? edit.newText : ''
    expect(text).toStartWith(
      '## Feature flags\n\n| Key | Description | Defined in | Used in | Environments | Documented |',
    )
    expect(text).toContain(
      '| new_hub | Redesigned hub | games/adventure/src/flags.json, games/app/src/flags.json | games/adventure, games/app | dev: true; prod: false | yes |',
    )
    expect(text).toContain('### Findings\n\n- error: Feature flag ghost_flag is referenced')
  })

  test('suggests no change when the repository file is current, and creates missing ones', async () => {
    const first = await run().data
    const edit = first.changes[0]?.edits[0]
    const current = edit?.kind === 'replace' ? edit.newText : ''
    const same = await run(featureFlags, {
      ...forgeFiles,
      'infra/helm': { ...forgeFiles['infra/helm'], 'docs/flags.md': current },
    }).data
    expect(same.changes).toEqual([])
    const { 'docs/flags.md': _, ...helm } = forgeFiles['infra/helm']!
    const created = await run(featureFlags, { ...forgeFiles, 'infra/helm': helm }).data
    expect(created.changes[0]?.edits[0]?.kind).toBe('create')
  })
})

describe('runTracker problems', () => {
  const base: TrackerDefinitionInput = {
    id: 't',
    name: 'T',
    sources: [
      {
        kind: 'files',
        role: 'definition',
        paths: ['flags.json'],
        extract: { kind: 'json-path', path: '$.*' },
      },
    ],
  }

  test('records unreadable files, missing providers and listing gaps as errors', async () => {
    const definition: TrackerDefinitionInput = {
      ...base,
      sources: [
        ...base.sources,
        {
          kind: 'document',
          role: 'documentation',
          provider: 'notion',
          ref: 'p',
          extract: { kind: 'list' },
        },
        {
          kind: 'document',
          role: 'documentation',
          provider: 'confluence',
          ref: 'missing',
          extract: { kind: 'list' },
        },
      ],
      outputs: [{ kind: 'document-section', provider: 'notion', ref: 'p' }],
    }
    const forge = fakeForge({ a: { 'flags.json': '{ broken' }, b: { 'flags.json': '{"x": 1}' } })
    const data = await runTracker(definition, {
      forge,
      repos: [
        { forge: 'f', path: 'a' },
        { forge: 'f', path: 'b' },
      ],
      documents: { confluence: fakeDocuments([]) },
      sinkProviders: ['confluence'],
      now,
    })
    expect(data.entities.map((entity) => entity.key)).toEqual(['x'])
    expect(
      data.errors.map((error) => [
        error.source ?? error.output,
        error.repo ?? error.document,
        error.message.split(':')[0],
      ]),
    ).toEqual([
      ['files-1', 'a', 'json-path'],
      ['document-2', 'notion:p', 'no document source for provider notion'],
      ['document-3', 'confluence:missing', 'page missing not found'],
      [
        'document-section-1',
        'notion:p',
        'no document sink for provider notion; the section cannot be published',
      ],
    ])
    expect(data.publications[0]).toMatchObject({ markerId: '', format: 'storage' })
    expect(data.publications[0]?.expectedVersion).toBeUndefined()

    const { listFiles: _, ...withoutListing } = forge
    const globbed = await runTracker(
      {
        ...base,
        sources: [
          {
            kind: 'files',
            role: 'definition',
            paths: ['*.json'],
            extract: { kind: 'json-path', path: '$.*' },
          },
        ],
      },
      { forge: withoutListing, repos: [{ forge: 'f', path: 'b' }], now },
    )
    expect(globbed.errors[0]?.message).toContain('cannot list files')
  })

  test('caps files per repository', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`f/${index}.txt`, `k${index}\n`]),
    )
    const data = await runTracker(
      {
        ...base,
        sources: [
          {
            kind: 'files',
            role: 'definition',
            paths: ['f/*.txt'],
            maxFiles: 2,
            extract: { kind: 'lines' },
          },
        ],
      },
      { forge: fakeForge({ r: files }), repos: [{ forge: 'f', path: 'r' }], now },
    )
    expect(data.entities.map((entity) => entity.key)).toEqual(['k0', 'k1'])
    expect(data.sourcesRead[0]?.skipped).toBe(3)
    expect(data.errors[0]?.message).toContain('maxFiles')
  })

  test('resolves groups and rejects unknown ones', async () => {
    const forge = fakeForge({ x: { 'flags.json': '{"a": 1}' }, y: { 'flags.json': '{"b": 1}' } })
    const data = await runTracker(
      {
        ...base,
        sources: [
          {
            kind: 'files',
            role: 'definition',
            groups: ['other', 'nope'],
            paths: ['flags.json'],
            extract: { kind: 'json-path', path: '$.*' },
          },
        ],
      },
      {
        forge,
        repos: [{ forge: 'f', path: 'x' }],
        groupRepos: (group) => (group === 'other' ? [{ forge: 'f', path: 'y' }] : undefined),
        now,
      },
    )
    expect(data.entities.map((entity) => entity.key)).toEqual(['b'])
    expect(data.errors).toEqual([{ source: 'files-1', message: 'group nope is unknown' }])
  })

  test('rejects invalid definitions', async () => {
    const duplicate = {
      ...base,
      outputs: [
        { kind: 'notify', id: 'n' },
        { kind: 'notify', id: 'n' },
      ],
    } as TrackerDefinitionInput
    expect(runTracker(duplicate, { repos: [], now })).rejects.toThrow(/duplicate id n/)
    expect(runTracker({ ...base, sources: [] }, { repos: [], now })).rejects.toThrow()
  })
})

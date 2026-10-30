import { describe, expect, test } from 'bun:test'

import { classifyProposal } from './classify.ts'

const reactTask = {
  taskKind: 'propagate',
  packages: [
    { ecosystem: 'npm', name: 'react', from: '18.3.1', to: '19.0.0' },
    { ecosystem: 'npm', name: 'lodash', from: '4.17.20', to: '4.17.21' },
  ],
}

const kind = (title: string, body = '') => classifyProposal({ title, body }).kind

describe('classifyProposal', () => {
  test('a react note during a react 18 → 19 propagation becomes a react migration', () => {
    const result = classifyProposal(
      {
        title: 'forwardRef is no longer needed',
        body: 'With React 19, pass `ref` as a prop. Remove forwardRef wrappers in tests too.',
      },
      reactTask,
    )
    expect(result).toEqual({
      kind: 'migration',
      topics: ['testing', 'dependencies'],
      appliesTo: ['propagate', 'port', 'review', 'tests'],
      packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19', to: '>=19 <20' }],
    })
  })

  test('keeps what the proposal already says', () => {
    const result = classifyProposal(
      {
        title: 'React upgrade notes',
        body: 'Upgrade react carefully.',
        kind: 'howto',
        topics: ['Frontend'],
        appliesTo: ['review'],
        packages: [{ ecosystem: 'npm', name: 'react', to: '>=19' }],
      },
      reactTask,
    )
    expect(result).toEqual({
      kind: 'howto',
      topics: ['frontend', 'dependencies'],
      appliesTo: ['review'],
      packages: [{ ecosystem: 'npm', name: 'react', to: '>=19' }],
    })
  })

  test('detects kinds from wording', () => {
    expect(kind('Always use named exports')).toBe('convention')
    expect(kind('Flaky CI on Mondays', 'Workaround: retry the job.')).toBe('quirk')
    expect(kind('How to regenerate fixtures', 'Run `bun run fixtures`.')).toBe('howto')
    expect(kind('We chose Postgres for jobs')).toBe('decision')
    expect(kind('Migrate to the new API', 'No package hint, so not a migration.')).toBe('decision')
  })

  test('explicit migrations without mentioned packages take the task packages', () => {
    const result = classifyProposal(
      { title: 'Bump notes', body: 'x', kind: 'migration' },
      reactTask,
    )
    expect(result.packages?.map((pkg) => pkg.name)).toEqual(['react', 'lodash'])
  })

  test('topics and task kinds from keywords', () => {
    expect(
      classifyProposal({ title: 'Translations', body: 'Plural forms need ICU in locale files.' }),
    ).toEqual({ kind: 'decision', topics: ['i18n'], appliesTo: ['*'] })
    expect(
      classifyProposal(
        { title: 'Prefer snapshot tests for emails', body: '' },
        { taskKind: 'review' },
      ),
    ).toEqual({
      kind: 'convention',
      topics: ['testing'],
      appliesTo: ['review', 'quality', 'tests'],
    })
    expect(classifyProposal({ title: 'Release on Tuesdays', body: '' }).appliesTo).toEqual([
      'release-risk',
    ])
  })

  test('matches scoped package names by their last segment, as whole words', () => {
    const task = {
      taskKind: 'port',
      packages: [{ ecosystem: 'npm', name: '@tanstack/react-query', from: '4.0.0', to: '5.0.0' }],
    }
    expect(
      classifyProposal({ title: 'react-query v5', body: 'isLoading is renamed' }, task).kind,
    ).toBe('migration')
    const plain = classifyProposal({ title: 'react notes', body: 'nothing' }, task)
    expect(plain.packages).toBeUndefined()
  })
})

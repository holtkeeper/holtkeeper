import { describe, expect, test } from 'bun:test'

import { parseRuleFile, readRepoRules, ruleFilePaths } from './repo-files.ts'

describe('ruleFilePaths', () => {
  test('keeps rules files, root ones first, skipping vendored folders', () => {
    expect(
      ruleFilePaths([
        'src/widgets/AGENTS.md',
        'CONTRIBUTING.md',
        'AGENTS.md',
        'REVIEW.md',
        'node_modules/some-lib/AGENTS.md',
        '.cursor/rules/forms.mdc',
        '.github/instructions/api.instructions.md',
        'README.md',
        'src/index.ts',
      ]),
    ).toEqual([
      'REVIEW.md',
      'AGENTS.md',
      'CONTRIBUTING.md',
      '.cursor/rules/forms.mdc',
      '.github/instructions/api.instructions.md',
      'src/widgets/AGENTS.md',
    ])
  })
})

describe('parseRuleFile', () => {
  test('root files always apply', () => {
    expect(parseRuleFile('AGENTS.md', '# Rules\n- Use tabs.')).toEqual({
      path: 'AGENTS.md',
      text: '# Rules\n- Use tabs.',
      kind: 'always',
      globs: [],
    })
  })

  test('nested AGENTS.md applies under its folder', () => {
    expect(parseRuleFile('pkg/widgets/AGENTS.md', '- Keep shapes pure.')).toMatchObject({
      kind: 'files',
      globs: ['pkg/widgets/**'],
    })
  })

  test('Copilot instructions follow applyTo and excludeAgent', () => {
    expect(
      parseRuleFile(
        '.github/instructions/api.instructions.md',
        '---\napplyTo: "api/**/*.ts,lib/**"\nexcludeAgent: "code-review"\n---\nValidate input.',
      ),
    ).toMatchObject({
      kind: 'files',
      globs: ['api/**/*.ts', 'lib/**'],
      agents: ['task', 'chat', 'release'],
    })
    expect(
      parseRuleFile(
        '.github/instructions/all.instructions.md',
        '---\napplyTo: "**"\n---\nBe brief.',
      ),
    ).toMatchObject({ kind: 'always' })
  })

  test('Cursor rules: always, globs, description, manual', () => {
    expect(parseRuleFile('.cursor/rules/a.mdc', '---\nalwaysApply: true\n---\nA')).toMatchObject({
      kind: 'always',
    })
    expect(parseRuleFile('.cursor/rules/b.mdc', '---\nglobs: src/*.ts\n---\nB')).toMatchObject({
      kind: 'files',
      globs: ['src/*.ts'],
    })
    expect(
      parseRuleFile('.cursor/rules/c.mdc', '---\ndescription: Shape math\n---\nC'),
    ).toMatchObject({ kind: 'requested', description: 'Shape math' })
    expect(parseRuleFile('.cursor/rules/d.mdc', '---\nalwaysApply: false\n---\nD')).toBeUndefined()
  })

  test('Claude Code rules follow paths and otherwise always apply', () => {
    expect(
      parseRuleFile('.claude/rules/ui.md', '---\npaths:\n  - "web/**"\n---\nUse tokens.'),
    ).toMatchObject({ kind: 'files', globs: ['web/**'] })
    expect(parseRuleFile('.claude/rules/general.md', 'Be brief.')).toMatchObject({ kind: 'always' })
  })

  test('Windsurf triggers', () => {
    expect(
      parseRuleFile('.windsurf/rules/a.md', '---\ntrigger: glob\nglobs: "*.go"\n---\nA'),
    ).toMatchObject({ kind: 'files', globs: ['*.go'] })
    expect(parseRuleFile('.windsurf/rules/b.md', '---\ntrigger: manual\n---\nB')).toBeUndefined()
  })

  test('blank bodies are skipped', () => {
    expect(parseRuleFile('AGENTS.md', '---\nx: 1\n---\n  \n')).toBeUndefined()
  })
})

describe('readRepoRules', () => {
  test('reads only rules files that exist', async () => {
    const files: Record<string, string> = {
      'AGENTS.md': '- Root rule.',
      'pkg/AGENTS.md': '- Package rule.',
    }
    const read: string[] = []
    const rules = await readRepoRules({
      paths: ['AGENTS.md', 'pkg/AGENTS.md', 'CLAUDE.md', 'pkg/index.ts'],
      read: async (path) => {
        read.push(path)
        return files[path]
      },
    })
    expect(read).toEqual(['AGENTS.md', 'CLAUDE.md', 'pkg/AGENTS.md'])
    expect(rules.map((rule) => rule.path)).toEqual(['AGENTS.md', 'pkg/AGENTS.md'])
  })
})

import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { enforcedBy, explicitRules } from './explicit.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function rulesOf(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'explicit-'))
  dirs.push(dir)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await Bun.write(join(dir, path), text)
  }
  return explicitRules(dir, Object.keys(files))
}

test('reads naming rules from linter configs', async () => {
  const rules = await rulesOf({
    'packages/widget/eslint.config.mjs':
      "export default [{ rules: { '@typescript-eslint/naming-convention': ['error', {}] } }]\n",
    'pyproject.toml': '[tool.ruff.lint]\nselect = ["E", "N"]\n',
    'node_modules/some-lib/.ls-lint.yml': 'ls: {}\n',
  })
  expect(rules).toEqual([
    {
      tool: 'eslint',
      dir: 'packages/widget',
      scope: 'identifiers',
      languages: ['typescript', 'javascript'],
    },
    { tool: 'ruff', dir: '', scope: 'identifiers', languages: ['python'] },
  ])
  expect(enforcedBy(rules, 'packages/widget/src/a.ts', 'typescript', 'identifiers')).toBe('eslint')
  expect(enforcedBy(rules, 'packages/other/a.ts', 'typescript', 'identifiers')).toBeUndefined()
  expect(enforcedBy(rules, 'app/main.py', 'python', 'file names')).toBeUndefined()
})

test('ignores rules that are switched off or other tools sections', async () => {
  const rules = await rulesOf({
    '.eslintrc.json': '{ "rules": { "@typescript-eslint/naming-convention": "off" } }\n',
    'pyproject.toml': '[tool.other]\nselect = ["N"]\n',
  })
  expect(rules).toEqual([])
})

test('limits naming-convention to the kinds its selectors name', async () => {
  const rules = await rulesOf({
    'eslint.config.js': [
      "export default [{ rules: { 'no-restricted-syntax': ['error', { selector: 'WithStatement' }],",
      "  '@typescript-eslint/naming-convention': ['error',",
      "    { selector: 'typeLike', format: ['PascalCase'] },",
      "    { selector: ['enumMember', 'parameter'], format: ['UPPER_CASE'] }] } }]",
    ].join('\n'),
    'widget/.oxlintrc.json':
      '{ "rules": { "typescript/naming-convention": ["error", { "selector": "default", "format": ["camelCase"] }] } }',
  })
  expect(rules.map(({ tool, kinds }) => ({ tool, kinds }))).toEqual([
    { tool: 'eslint', kinds: ['class', 'type', 'enum', 'enum-member'] },
    { tool: 'oxlint', kinds: undefined },
  ])
  expect(enforcedBy(rules, 'src/a.ts', 'typescript', 'identifiers', 'class')).toBe('eslint')
  expect(enforcedBy(rules, 'src/a.ts', 'typescript', 'identifiers', 'local-variable')).toBe(
    undefined,
  )
  expect(enforcedBy(rules, 'widget/a.ts', 'typescript', 'identifiers', 'local-variable')).toBe(
    'oxlint',
  )
})

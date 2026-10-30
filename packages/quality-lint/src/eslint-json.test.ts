import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diskFiles, planChanges } from '@holtkeeper/changes'

import { parseEslintJson } from './eslint-json.ts'

const source =
  'const unused = 1\nlet y = 5\nif (y == null) y = 2\nexport { y }\nlet z = 1\nexport { z }\n'
const at = (text: string) => source.indexOf(text)

function report(dir: string) {
  return {
    results: [
      {
        filePath: join(dir, 'src/a.js'),
        messages: [
          {
            ruleId: 'no-unused-vars',
            severity: 2,
            message: "'unused' is assigned a value but never used.",
            line: 1,
            column: 7,
            nodeType: 'Identifier',
            messageId: 'unusedVar',
            endLine: 1,
            endColumn: 13,
            suggestions: [
              {
                messageId: 'removeVar',
                desc: "Remove unused variable 'unused'.",
                fix: { range: [0, 17], text: '' },
              },
            ],
          },
          {
            ruleId: 'eqeqeq',
            severity: 1,
            message: "Expected '===' and instead saw '=='.",
            line: 3,
            column: 7,
            endLine: 3,
            endColumn: 9,
            suggestions: [
              {
                desc: "Use '===' instead of '=='.",
                fix: { range: [at('=='), at('==') + 2], text: '===' },
              },
            ],
          },
          {
            ruleId: 'prefer-const',
            severity: 2,
            message: "'z' is never reassigned. Use 'const' instead.",
            line: 5,
            column: 5,
            endLine: 5,
            endColumn: 6,
            fix: { range: [at('let z'), at('let z') + 3], text: 'const' },
          },
          {
            ruleId: null,
            fatal: true,
            severity: 2,
            message: 'Parsing error: Unexpected token',
            line: 9,
            column: 1,
          },
        ],
        suppressedMessages: [],
        errorCount: 3,
        warningCount: 1,
        source,
      },
    ],
    metadata: {
      cwd: dir,
      rulesMeta: {
        'no-unused-vars': {
          type: 'problem',
          docs: {
            description: 'Disallow unused variables',
            url: 'https://eslint.org/docs/latest/rules/no-unused-vars',
          },
          hasSuggestions: true,
        },
        'prefer-const': {
          type: 'suggestion',
          docs: {
            description: 'Require `const` declarations',
            url: 'https://eslint.org/docs/latest/rules/prefer-const',
          },
          fixable: 'code',
        },
      },
    },
  }
}

describe('parseEslintJson', () => {
  test('converts messages, fixes and suggestions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quality-lint-eslint-'))
    try {
      await Bun.write(join(dir, 'src/a.js'), source)
      const { issues, changes } = await parseEslintJson(JSON.stringify(report(dir)), { dir })

      expect(issues.map((issue) => [issue.rule, issue.severity, issue.file])).toEqual([
        ['no-unused-vars', 'error', 'src/a.js'],
        ['eqeqeq', 'warning', 'src/a.js'],
        ['prefer-const', 'error', 'src/a.js'],
        ['fatal', 'error', 'src/a.js'],
      ])
      expect(issues[0]).toMatchObject({
        tool: 'eslint',
        category: 'lint',
        help: 'Disallow unused variables',
        url: 'https://eslint.org/docs/latest/rules/no-unused-vars',
        range: { start: { line: 1, column: 7 }, end: { line: 1, column: 13 } },
      })
      expect(changes.map((change) => [change.title, change.confidence])).toEqual([
        ["Remove unused variable 'unused'.", 'review'],
        ["Use '===' instead of '=='.", 'review'],
        ['Fix prefer-const', 'safe'],
      ])
      expect(issues.slice(0, 3).map((issue) => issue.changeId)).toEqual(
        changes.map((change) => change.id),
      )
      expect(changes[2]?.edits[0]).toMatchObject({
        oldText: 'let',
        range: { start: { line: 5, column: 1 } },
      })

      // Each change is planned on top of the previous ones, so later positions go first.
      const plan = await planChanges(changes.toReversed(), diskFiles(dir))
      expect(plan.conflicts).toEqual([])
      expect(plan.files[0]?.content).toBe(
        'let y = 5\nif (y === null) y = 2\nexport { y }\nconst z = 1\nexport { z }\n',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('accepts the plain json format and files with a byte-order mark', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quality-lint-eslint-'))
    try {
      await Bun.write(join(dir, 'b.js'), '\uFEFFvar a = 1\n')
      const plain = [
        {
          filePath: join(dir, 'b.js'),
          messages: [
            {
              ruleId: 'no-var',
              severity: 2,
              message: 'Unexpected var.',
              line: 1,
              column: 1,
              fix: { range: [0, 3], text: 'let' },
            },
          ],
        },
      ]
      const { changes } = await parseEslintJson(plain, { dir })
      expect(changes[0]?.edits[0]).toMatchObject({ oldText: 'var', newText: 'let' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects other shapes', () =>
    expect(parseEslintJson({ runs: [] }, { dir: '.' })).rejects.toThrow())
})

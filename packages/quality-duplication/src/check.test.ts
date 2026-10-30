import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { duplicationCheck, jscpdCommand } from './check.ts'

const captured = await Bun.file(join(import.meta.dir, '../test/jscpd-report.json')).text()

const outputOf = (command: readonly string[]) => command[command.indexOf('--output') + 1] ?? ''

describe('duplicationCheck', () => {
  test('builds the jscpd command from options', () => {
    const command = jscpdCommand(
      {
        bin: 'jscpd',
        minTokens: 30,
        minLines: 4,
        formats: ['typescript', 'go'],
        ignore: ['**/gen/**'],
      },
      '/out',
    )
    expect(command.slice(0, 6)).toEqual([
      'jscpd',
      '--reporters',
      'json',
      '--output',
      '/out',
      '--silent',
    ])
    expect(command[command.indexOf('--ignore') + 1]).toEndWith(',**/gen/**')
    expect(command[command.indexOf('--ignore') + 1]).toContain('**/node_modules/**')
    expect(command.slice(-7)).toEqual([
      '--min-tokens',
      '30',
      '--min-lines',
      '4',
      '--format',
      'typescript,go',
      '.',
    ])
    expect(command).not.toContain('--no-gitignore')
  })

  test('runs jscpd and reads its report', async () => {
    const { runner, calls } = createFakeRunner(async (command) => {
      if (command[1] === '--version') return { stdout: 'jscpd 5.4.2\n' }
      await Bun.write(join(outputOf(command), 'jscpd-report.json'), captured)
      return { stdout: 'Found 1 exact clones' }
    })
    const result = await duplicationCheck({ bin: 'jscpd' }).run({ dir: '/project', runner })
    expect(result.version).toBe('5.4.2')
    expect(result.duplication).toEqual({ percentage: 50, duplicatedLines: 13, totalLines: 26 })
    expect(result.issues).toHaveLength(1)
    expect(calls.map((call) => call.options.cwd)).toEqual(['/project', '/project'])
    expect(await Bun.file(outputOf(calls[1]?.command ?? [])).exists()).toBe(false)
  })

  test('fails when jscpd writes no report', async () => {
    const { runner } = createFakeRunner((command) =>
      command[1] === '--version'
        ? { stdout: 'jscpd 5.4.2' }
        : { exitCode: 2, stderr: 'bad option' },
    )
    expect(duplicationCheck({ bin: 'jscpd' }).run({ dir: '/project', runner })).rejects.toThrow(
      'bad option',
    )
  })
})

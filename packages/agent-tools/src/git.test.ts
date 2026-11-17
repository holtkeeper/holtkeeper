import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentTool, ToolContext } from '@holtkeeper/agent'
import { localRunner } from '@holtkeeper/exec'
import { createFakeRunner } from '@holtkeeper/exec/testing'

import { gitTools } from './git.ts'
import { ToolError } from './tool.ts'

const ctx = (dir = '/work/widget'): ToolContext => ({ dir, signal: new AbortController().signal })

const toolOf = (tools: AgentTool[], name: string) => {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

/** The git subcommand and its arguments, without the fixed global options. */
const argsOf = (command: string[]) => command.slice(command.indexOf('color.ui=false') + 1)

/** `git.show` of a sha git does not know, in a checkout that is shallow or not. */
const showUnknown = (shallow: boolean) => {
  const { runner } = createFakeRunner((command) =>
    command.includes('--is-shallow-repository')
      ? { stdout: `${shallow}\n` }
      : {
          exitCode: 128,
          stderr:
            "fatal: ambiguous argument 'deadbeef': unknown revision or path not in the working tree.",
        },
  )
  return toolOf(gitTools({ runner }).tools, 'git.show').run({ rev: 'deadbeef' }, ctx())
}

describe('gitTools with a fake runner', () => {
  test('builds read-only commands with global safety options in the task directory', async () => {
    const { runner, calls } = createFakeRunner(() => ({
      stdout: 'abc1234 2026-01-02 Foo: Add widget\n',
    }))
    const tools = gitTools({ runner }).tools
    const out = await toolOf(tools, 'git.log').run({ path: 'src/widget.ts', limit: 5 }, ctx())
    expect(out).toBe('abc1234 2026-01-02 Foo: Add widget')
    const [call] = calls
    expect(call?.options.cwd).toBe('/work/widget')
    expect(call?.command.slice(0, 7)).toEqual([
      'git',
      '--no-pager',
      '--literal-pathspecs',
      '-c',
      'core.quotepath=off',
      '-c',
      'color.ui=false',
    ])
    expect(argsOf(call?.command ?? [])).toEqual([
      'log',
      '--no-color',
      '--format=%h %ad %an: %s',
      '--date=short',
      '--max-count=6',
      'HEAD',
      '--',
      'src/widget.ts',
    ])
  })

  test('git.diff passes both revisions separately and paths after --', async () => {
    const { runner, calls } = createFakeRunner()
    const out = await toolOf(gitTools({ runner }).tools, 'git.diff').run(
      { from: 'abc1234', path: 'lib' },
      ctx(),
    )
    expect(out).toContain('diff abc1234 → HEAD (lib)')
    expect(out).toContain('no changes')
    expect(calls.map((call) => argsOf(call.command))).toEqual([
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--stat',
        'abc1234',
        'HEAD',
        '--',
        'lib',
      ],
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--patch',
        'abc1234',
        'HEAD',
        '--',
        'lib',
      ],
    ])
  })

  test('git.blame clamps the range and says where to continue', async () => {
    const { runner, calls } = createFakeRunner()
    const out = await toolOf(gitTools({ runner }).tools, 'git.blame').run(
      { path: 'src/foo.ts', start: 10, end: 1000 },
      ctx(),
    )
    expect(argsOf(calls[0]?.command ?? [])).toEqual([
      'blame',
      '--date=short',
      '-L',
      '10,207',
      'HEAD',
      '--',
      'src/foo.ts',
    ])
    expect(out).toContain('continue with start=208')
    expect(
      toolOf(gitTools({ runner }).tools, 'git.blame').run({ path: 'a', start: 5, end: 2 }, ctx()),
    ).rejects.toThrow('end (2) is before start (5)')
  })

  test.each([
    '--output=/tmp/x',
    '-p',
    'HEAD..main',
    'main...HEAD',
    'HEAD@{1}',
    'a b',
    'foo;rm',
    'refs/heads/',
    '',
  ])('rejects the revision %p without running git', async (rev) => {
    const { runner, calls } = createFakeRunner()
    const show = toolOf(gitTools({ runner }).tools, 'git.show')
    expect(show.run({ rev }, ctx())).rejects.toBeInstanceOf(ToolError)
    expect(calls).toEqual([])
  })

  test.each([
    'HEAD',
    'HEAD~3',
    'HEAD^2',
    'origin/feature-x',
    'refs/tags/v1.2.0',
    '7d6c',
    'abc1234def',
  ])('accepts the revision %p', async (rev) => {
    const { runner, calls } = createFakeRunner()
    await toolOf(gitTools({ runner }).tools, 'git.show').run({ rev }, ctx())
    expect(calls[0]?.command).toContain(rev)
  })

  test.each(['/etc/passwd', '../outside', 'src/../../outside', 'C:/widget'])(
    'rejects the path %p',
    async (path) => {
      const { runner, calls } = createFakeRunner()
      const log = toolOf(gitTools({ runner }).tools, 'git.log')
      expect(log.run({ path }, ctx())).rejects.toBeInstanceOf(ToolError)
      expect(calls).toEqual([])
    },
  )

  test('an unknown revision names it; a shallow checkout is mentioned only when git says so', async () => {
    expect(showUnknown(false)).rejects.toThrow(/^unknown revision deadbeef$/)
    expect(showUnknown(true)).rejects.toThrow(
      'commit deadbeef is not in this checkout; fetch may be shallow',
    )
  })

  test('other git failures reach the agent as they are', async () => {
    const { runner } = createFakeRunner(() => ({
      exitCode: 128,
      stderr: "fatal: no such path 'src/gone.ts' in HEAD",
    }))
    expect(
      toolOf(gitTools({ runner }).tools, 'git.blame').run(
        { path: 'src/gone.ts', start: 1, end: 2 },
        ctx(),
      ),
    ).rejects.toThrow("fatal: no such path 'src/gone.ts' in HEAD")
  })

  test('git.show caps a long patch and names the files that were cut', async () => {
    const patch = [
      'diff --git a/src/widget.ts b/src/widget.ts',
      ...Array.from({ length: 40 }, (_, i) => `+line ${i}`),
      'diff --git a/src/gadget.ts b/src/gadget.ts',
      ...Array.from({ length: 40 }, (_, i) => `+line ${i}`),
    ].join('\n')
    const { runner } = createFakeRunner((command) =>
      command.includes('--stat')
        ? { stdout: 'commit abc\nAuthor: Foo\n\n Add widget\n' }
        : { stdout: patch },
    )
    const out = await toolOf(
      gitTools({ runner, budget: { maxResultLines: 30 } }).tools,
      'git.show',
    ).run({ rev: 'abc1234' }, ctx())
    const lines = out.split('\n')
    expect(lines.length).toBeLessThanOrEqual(30)
    expect(lines.at(-1)).toMatch(
      /^… \d+ more patch lines cut \(src\/widget\.ts, src\/gadget\.ts\); pass path/,
    )
  })
})

describe('gitTools on a real repository', () => {
  test.skipIf(!Bun.which('git'))('show, log, diff and blame read the history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-tools-'))
    const env = {
      GIT_AUTHOR_NAME: 'Foo Bar',
      GIT_AUTHOR_EMAIL: 'foo@example.com',
      GIT_COMMITTER_NAME: 'Foo Bar',
      GIT_COMMITTER_EMAIL: 'foo@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    }
    const sh = async (...command: string[]) => {
      const result = await localRunner.run(command, { cwd: dir, env })
      if (result.exitCode !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    try {
      await sh('git', 'init', '-q', '-b', 'main')
      await writeFile(join(dir, 'widget.ts'), 'export const size = 1\nexport const color = "red"\n')
      await sh('git', 'add', '.')
      await sh('git', 'commit', '-q', '-m', 'Add widget', '-m', 'Widgets need a size.')
      const first = await sh('git', 'rev-parse', '--short', 'HEAD')
      await writeFile(join(dir, 'widget.ts'), 'export const size = 2\nexport const color = "red"\n')
      await sh('git', 'commit', '-q', '-am', 'Grow widget')
      const second = await sh('git', 'rev-parse', 'HEAD')

      const tools = gitTools({ runner: localRunner }).tools
      const run = (name: string, input: Record<string, unknown>) =>
        toolOf(tools, name).run(input, ctx(dir))

      const show = await run('git.show', { rev: first })
      expect(show).toContain('Author: Foo Bar')
      expect(show).toContain('Widgets need a size.')
      expect(show).toContain('widget.ts | 2 ++')
      expect(show).toContain('+export const size = 1')

      const log = (await run('git.log', { path: 'widget.ts' })).split('\n')
      expect(log).toHaveLength(2)
      expect(log[0]).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Foo Bar: Grow widget$/)
      expect(log[1]).toStartWith(`${first} `)

      const diff = await run('git.diff', { from: first })
      expect(diff).toContain('-export const size = 1')
      expect(diff).toContain('+export const size = 2')

      const blame = await run('git.blame', { path: 'widget.ts', start: 1, end: 2 })
      expect(blame).toContain(second.slice(0, 7))
      expect(blame).toContain('Foo Bar')
      expect(blame).toContain('export const color = "red"')

      expect(run('git.show', { rev: 'deadbeef' })).rejects.toThrow('unknown revision deadbeef')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

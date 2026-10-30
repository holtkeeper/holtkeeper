import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { docsTools } from '../src/index.ts'
import { call, createFixture, type Fixture } from './fixture.ts'

let fixture: Fixture
beforeAll(async () => {
  fixture = await createFixture()
})
afterAll(() => fixture.cleanup())

const docs = docsTools()
const run = (input: Record<string, unknown>) => call(docs, 'docs.package', input, fixture.ctx)

describe('docs.package (npm)', () => {
  test('summary names the installed version and available docs', async () => {
    expect(await run({ name: 'left-pad' })).toBe(
      [
        'left-pad 2.1.0 at node_modules/left-pad',
        'Pads strings on the left.',
        'types: index.d.ts',
        'docs: README.md, CHANGELOG.md, MIGRATION.md',
      ].join('\n'),
    )
    expect(await run({ name: 'missing' })).toContain('is not installed')
    expect(run({ name: '../../etc' })).rejects.toThrow('not an npm package name')
  })

  test('resolves from a workspace directory upwards', async () => {
    await mkdir(join(fixture.dir, 'packages/a'), { recursive: true })
    expect(await run({ name: 'left-pad', workspace: 'packages/a' })).toStartWith('left-pad 2.1.0')
  })

  test('changelog returns only releases in the range', async () => {
    const out = await run({ name: 'left-pad', show: 'changelog', from: '1.5.0', to: '2.1.0' })
    expect(out).toContain('2 releases')
    expect(out).toContain('## [2.1.0]')
    expect(out).toContain('- Removed callback API.')
    expect(out).not.toContain('Faster')
    expect(
      await run({ name: 'left-pad', show: 'changelog', from: '0.1.0', to: '1.0.0' }),
    ).toContain('## v1.0.0')
    expect(await run({ name: 'left-pad', show: 'changelog', from: '3.0.0' })).toContain(
      'no releases between 3.0.0 and the latest',
    )
  })

  test('migration picks the guide sections leading into the range', async () => {
    const out = await run({ name: 'left-pad', show: 'migration', from: '1.5.0', to: '2.1.0' })
    expect(out).toContain('## Migrating from v1 to v2')
    expect(out).not.toContain('v2 to v3')
  })

  test('readme gives an overview or one section', async () => {
    const overview = await run({ name: 'left-pad', show: 'readme' })
    expect(overview).toContain('Pads a string.')
    expect(overview).toContain('  9 Usage')
    expect(overview).not.toContain('not a heading')
    const usage = await run({ name: 'left-pad', show: 'readme', heading: 'usage' })
    expect(usage).toContain("leftPad('a', 3)")
    expect(usage).not.toContain('npm i')
  })

  test('api outlines the declarations, following re-exports', async () => {
    const out = await run({ name: 'left-pad', show: 'api' })
    expect(out).toContain(
      '2 export declare function leftPad(text: string, length: number, fill?: string): string',
    )
    expect(out).toContain('# extra.d.ts\n1 export declare function padEnd')
    const filtered = await run({ name: 'left-pad', show: 'api', heading: 'padend' })
    expect(filtered).toContain('padEnd')
    expect(filtered).not.toContain('leftPad')
  })

  test('respects the line budget', async () => {
    const root = join(fixture.dir, 'node_modules/huge')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'huge', version: '9.0.0' }))
    const releases = Array.from({ length: 50 }, (_, i) => `## 1.${50 - i}.0\n\n- change ${i}\n`)
    await writeFile(join(root, 'CHANGELOG.md'), `# Changes\n\n${releases.join('\n')}`)
    const small = docsTools({ budget: { maxResultLines: 15 } })
    const out = await call(
      small,
      'docs.package',
      { name: 'huge', show: 'changelog', from: '1.0.0' },
      fixture.ctx,
    )
    expect(out.split('\n')).toHaveLength(15)
    expect(out).toMatch(/… \d+ more lines$/)
    expect(await run({ name: 'huge', show: 'api' })).toContain('no type declarations')
  })
})

describe('docs.package (go)', () => {
  test('uses go doc through the runner', async () => {
    const { runner, calls } = createFakeRunner((command) =>
      command[1] === 'doc'
        ? {
            stdout:
              'func Join(elem ...string) string\nfunc Split(path string) (dir, file string)\n',
          }
        : undefined,
    )
    const out = await call(
      docsTools({ runner }),
      'docs.package',
      { name: 'path/filepath', ecosystem: 'go', show: 'api' },
      fixture.ctx,
    )
    expect(out).toContain('func Join')
    expect(calls[0]?.command).toEqual(['go', 'doc', '-short', 'path/filepath'])
    await call(
      docsTools({ runner }),
      'docs.package',
      { name: 'path/filepath', ecosystem: 'go', show: 'api', heading: 'Join' },
      fixture.ctx,
    )
    expect(calls[1]?.command).toEqual(['go', 'doc', 'path/filepath', 'Join'])
  })

  test('reads the module changelog from go list', async () => {
    const { runner } = createFakeRunner((command) =>
      command[1] === 'list'
        ? { stdout: `${join(fixture.dir, 'node_modules/left-pad')}|v2.1.0\n` }
        : undefined,
    )
    const out = await call(
      docsTools({ runner }),
      'docs.package',
      { name: 'example.com/pad', ecosystem: 'go', show: 'changelog', from: '2.0.0' },
      fixture.ctx,
    )
    expect(out).toStartWith('example.com/pad v2.1.0 at example.com/pad — CHANGELOG.md: 1 releases')
  })

  test('reports when no runner is configured', async () => {
    expect(await run({ name: 'example.com/pad', ecosystem: 'go' })).toContain('not available')
  })
})

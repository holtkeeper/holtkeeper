import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CommitInput, GitForge, MergeRequest } from '@holtkeeper/forge'

import { type PublishInput, publishChange } from './publish.ts'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

const mergeRequest = (id: number): MergeRequest => ({
  id,
  title: 'chore: grow the widget',
  description: '',
  sourceBranch: 'holtkeeper/ab12cd-grow',
  targetBranch: 'main',
  state: 'open',
  draft: true,
  labels: [],
  author: 'holtkeeper',
  webUrl: `https://forge.test/mr/${id}`,
})

function fakeForge(options: { open?: boolean; onBranch?: Record<string, string> } = {}) {
  const commits: CommitInput[] = []
  const deleted: string[] = []
  const forge = {
    async findMergeRequest() {
      return options.open ? mergeRequest(3) : undefined
    },
    async deleteBranch(_repo: string, branch: string) {
      deleted.push(branch)
      throw new Error('404 branch not found')
    },
    async readFile(_repo: string, file: string) {
      return options.onBranch?.[file]
    },
    async commit(_repo: string, input: CommitInput) {
      commits.push(input)
      return { sha: 'c0ffee12', webUrl: 'https://forge.test/c0ffee12' }
    },
    async createMergeRequest() {
      return mergeRequest(4)
    },
    async updateMergeRequest() {
      return mergeRequest(3)
    },
  } as unknown as GitForge
  return { forge, commits, deleted }
}

async function checkout(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'write-task-publish-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content)
  return dir
}

const input = (forge: GitForge, dir: string, files: PublishInput['files']): PublishInput => ({
  forge,
  repo: 'shapes/widgets',
  dir,
  files,
  branch: 'holtkeeper/ab12cd-grow',
  targetBranch: 'main',
  message: 'chore: grow the widget',
  title: 'chore: grow the widget',
  description: '',
  draft: true,
})

describe('publishChange over the API', () => {
  test('refuses symlinks, so a link never publishes the file it points at', async () => {
    const { forge, commits } = fakeForge()
    const dir = await checkout({ 'widget.ts': 'export const size = 4\n' })
    await symlink('/etc/hosts', join(dir, 'leak'))
    const refused = await publishChange(
      input(forge, dir, [
        { path: 'widget.ts', action: 'update' },
        { path: 'leak', action: 'create' },
      ]),
    ).catch((error: unknown) => String(error))
    expect(refused).toContain('refusing to publish leak')
    expect(commits).toEqual([])
  })

  test('starts a branch left by an earlier run again from the target', async () => {
    const { forge, commits, deleted } = fakeForge()
    const dir = await checkout({ 'widget.ts': 'export const size = 4\n' })
    const published = await publishChange(
      input(forge, dir, [{ path: 'widget.ts', action: 'update' }]),
    )
    expect(published).toMatchObject({ id: 4, sha: 'c0ffee12' })
    expect(deleted).toEqual(['holtkeeper/ab12cd-grow'])
    expect(commits[0]).toMatchObject({ startBranch: 'main' })
  })

  test('with an open merge request, actions follow what the branch holds', async () => {
    const { forge, commits, deleted } = fakeForge({
      open: true,
      onBranch: { 'shape.ts': 'old\n', 'gone.ts': 'x\n' },
    })
    const dir = await checkout({ 'shape.ts': 'new\n', 'widget.ts': 'export const size = 4\n' })
    await publishChange(
      input(forge, dir, [
        { path: 'shape.ts', action: 'create' },
        { path: 'widget.ts', action: 'update' },
        { path: 'gone.ts', action: 'delete' },
        { path: 'never.ts', action: 'delete' },
      ]),
    )
    expect(deleted).toEqual([])
    expect(commits[0]?.startBranch).toBeUndefined()
    expect(commits[0]?.changes.map((change) => [change.action, change.path])).toEqual([
      ['update', 'shape.ts'],
      ['create', 'widget.ts'],
      ['delete', 'gone.ts'],
    ])
  })
})

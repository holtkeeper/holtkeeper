import { beforeEach, describe, expect, test } from 'bun:test'

import type { QaSummaryView, QaTaskList, QaTaskView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type {
  CommitQuery,
  CommitRecord,
  DiffFile,
  GitForge,
  MergeRequestRecord,
} from '@holtkeeper/forge'
import { qaSettingsDefinition } from '@holtkeeper/qa'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['releases:read', 'analyses:run'] }],
    viewer: [{ scope: { all: true }, actions: ['releases:read'] }],
    shapes: [{ scope: { teams: ['shapes'] }, actions: ['releases:read'] }],
  },
})
const as = (groups: string) => ({ 'x-forwarded-user': groups, 'x-forwarded-groups': groups })

const file = (diff: string): DiffFile => ({
  oldPath: 'src/panel.vue',
  newPath: 'src/panel.vue',
  status: 'modified',
  diff,
})

/** A small in-memory forge: branches of commits, merge requests and diffs per commit. */
function fakeRepo() {
  const commits = new Map<string, CommitRecord>()
  const branches = new Map<string, string>()
  const mergeRequests: MergeRequestRecord[] = []
  const diffs = new Map<string, string>()
  let minute = 0
  const commit = (branch: string, title: string, diff = '', parents?: string[]) => {
    const sha = `${branch[0]}${commits.size + 1}`
    const head = branches.get(branch)
    commits.set(sha, {
      sha,
      parents: parents ?? (head ? [head] : []),
      authorName: 'Dana',
      authorEmail: 'dana@example.com',
      authoredAt: new Date(Date.UTC(2026, 9, 20, 0, ++minute)).toISOString(),
      title,
      message: title,
    })
    diffs.set(sha, diff)
    branches.set(branch, sha)
    return sha
  }
  const reachable = (sha: string | undefined) => {
    const found = new Set<string>()
    const queue = sha ? [sha] : []
    while (queue.length) {
      const next = queue.pop()!
      if (found.has(next) || !commits.has(next)) continue
      found.add(next)
      queue.push(...commits.get(next)!.parents)
    }
    return found
  }
  const forge = {
    kind: 'gitlab',
    async getRepository(path: string) {
      return { path, name: path, defaultBranch: 'main', webUrl: '', cloneUrl: '', archived: false }
    },
    async listCommits(_repo: string, query: CommitQuery) {
      const head = branches.get(query.ref) ?? (commits.has(query.ref) ? query.ref : undefined)
      if (!head) throw new Error('404 ref')
      const excluded = reachable(query.since)
      return [...reachable(head)]
        .filter((sha) => !excluded.has(sha))
        .map((sha) => commits.get(sha)!)
        .filter((item) => !query.after || item.authoredAt >= query.after)
        .toSorted((a, b) => b.authoredAt.localeCompare(a.authoredAt))
        .slice(0, query.limit)
    },
    async listMergeRequests(_repo: string, query: { state?: string } = {}) {
      return mergeRequests.filter((mr) => mr.state === query.state)
    },
    async compareCommits(_repo: string, from: string, to: string) {
      const excluded = reachable(from)
      return [...reachable(to)]
        .filter((sha) => !excluded.has(sha))
        .map((sha) => diffs.get(sha) ?? '')
        .filter(Boolean)
        .map(file)
    },
    async getMergeRequestDiff() {
      return { files: [file('+<button data-testid="draft-save">Save</button>')] }
    },
  }
  return { forge: forge as unknown as GitForge, commit, branches, mergeRequests }
}

let app: ReturnType<typeof createApp>
let deps: Parameters<typeof createApp>[0]
let store: Store
let background: Promise<unknown>[]
let now: Date
let shapes: ReturnType<typeof fakeRepo>
let tools: ReturnType<typeof fakeRepo>

beforeEach(() => {
  now = new Date('2026-11-01T09:00:00.000Z')
  shapes = fakeRepo()
  shapes.commit('main', 'chore: start')
  shapes.commit('main', 'feat: ABC-1 show widget panel', '+<div data-testid="widget-panel">')
  shapes.commit('main', 'fix: ABC-000 tidy up')
  shapes.commit('main', 'docs: notes without a key')
  tools = fakeRepo()
  tools.commit('main', 'chore: start')
  const merged = tools.commit('main', 'feat: [ABC-1] widget helpers', '+export const size = 1')
  tools.mergeRequests.push({
    id: 7,
    title: 'ABC-1 Widget helpers',
    description: 'Adds helpers.',
    sourceBranch: 'feature/ABC-1',
    targetBranch: 'main',
    state: 'merged',
    draft: false,
    labels: [],
    author: 'dana',
    webUrl: 'https://forge.test/tools/-/merge_requests/7',
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-20T01:00:00.000Z',
    mergedAt: '2026-10-20T01:00:00.000Z',
    headSha: merged,
  })
  tools.mergeRequests.push({
    id: 8,
    title: 'ABC-2 Draft saving',
    description: '',
    sourceBranch: 'feature/ABC-2',
    targetBranch: 'main',
    state: 'open',
    draft: true,
    labels: [],
    author: 'lee',
    webUrl: 'https://forge.test/tools/-/merge_requests/8',
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    headSha: 'feedface',
  })
  background = []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  const forges = new Map([
    ['shapes/app', shapes.forge],
    ['tools/lib', tools.forge],
  ])
  deps = {
    config: parseConfig({
      forges: {
        work: {
          kind: 'gitlab',
          url: 'https://gitlab.test',
          create: () =>
            new Proxy({} as GitForge, {
              get: (_target, property: string) =>
                property === 'kind'
                  ? 'gitlab'
                  : (path: string, ...rest: unknown[]) =>
                      // oxlint-disable-next-line typescript/no-explicit-any -- dispatch by path
                      (forges.get(path) as any)[property](path, ...rest),
            }),
        },
      },
      teams: { shapes: { owns: ['work:shapes/app'] }, tools: { owns: ['work:tools/lib'] } },
    }),
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, qaSettingsDefinition],
    analyses: [],
    now: () => now,
    onBackground: (work) => {
      background.push(work)
    },
  }
  app = createApp(deps)
})

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const json = async <T>(path: string, headers = as('admin')) => {
  const response = await call('GET', path, headers)
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

/** Lists once so the repositories are read, waits for the reads and lists again. */
const listed = async (headers = as('admin'), query = '?days=30') => {
  await json<QaTaskList>(`/qa/tasks${query}`, headers)
  await Promise.all(background)
  return json<QaTaskList>(`/qa/tasks${query}`, headers)
}

describe('QA tasks', () => {
  test('reads repositories in the background, then lists tasks across them', async () => {
    const first = await json<QaTaskList>('/qa/tasks?days=30')
    expect(first.repos).toMatchObject({ listed: 2, read: 0, pending: 2 })
    await Promise.all(background)

    const list = await json<QaTaskList>('/qa/tasks?days=30')
    expect(list.repos).toMatchObject({ listed: 2, read: 2, pending: 0, failed: [] })
    expect(list.tasks.map((task) => task.key)).toEqual(['ABC-2', 'ABC-1'])
    const task = list.tasks.find((item) => item.key === 'ABC-1')!
    expect(task).toMatchObject({
      title: 'Widget helpers',
      counts: { merged: 1, open: 0, direct: 1 },
      authors: ['Dana'],
    })
    expect(task.repos.map((repo) => repo.path).toSorted()).toEqual(['shapes/app', 'tools/lib'])
    expect(list.tasks[0]?.counts).toEqual({ merged: 0, open: 1, direct: 0 })
    // Two start commits, the placeholder fix and the docs commit.
    expect(list.untracked).toBe(4)
  })

  test('lists only repositories the caller may read and honours the period', async () => {
    const list = await listed(as('shapes'))
    expect(list.repos.listed).toBe(1)
    expect(list.tasks.map((task) => task.key)).toEqual(['ABC-1'])
    now = new Date('2027-01-10T09:00:00.000Z')
    expect((await json<QaTaskList>('/qa/tasks?days=7', as('shapes'))).tasks).toEqual([])
    expect((await call('GET', '/qa/tasks?days=3', as('admin'))).status).toBe(400)
  })

  test('cuts placeholder keys by the qa setting', async () => {
    await store.settings.put({
      id: 'qa',
      key: 'qa',
      scope: { all: true },
      value: { catchAllKeys: ['ABC-2'] },
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const list = await listed()
    expect(list.tasks.map((task) => task.key)).toEqual(['ABC-1', 'ABC-000'])
  })

  test('shows the changes of a task with their files and test attributes', async () => {
    await listed()
    const view = await json<QaTaskView>('/qa/task?key=ABC-1')
    expect(view.changes.map((change) => [change.repo.path, change.kind])).toEqual([
      ['tools/lib', 'merge-request'],
      ['shapes/app', 'commit'],
    ])
    expect(view.changes[1]?.detail?.testIds).toEqual([
      {
        file: 'src/panel.vue',
        added: [{ attribute: 'data-testid', value: 'widget-panel' }],
        removed: [],
      },
    ])
    expect(view.can).toEqual({ summarize: false })
    expect(view.summarizeHint).toContain('no AI agent')

    const open = await json<QaTaskView>('/qa/task?key=ABC-2')
    expect(open.changes[0]?.detail?.testIds[0]?.added[0]?.value).toBe('draft-save')
    expect((await call('GET', '/qa/task?key=XYZ-9', as('admin'))).status).toBe(404)
  })

  test('writes a summary on request and marks it stale when new changes arrive', async () => {
    const prompts: string[] = []
    deps.agentFor = async () => ({
      name: 'fake',
      run: async (task) => {
        prompts.push(task.prompt)
        expect(task.taskKind).toBe('qa-notes')
        return {
          text: '',
          turns: 1,
          output: {
            overview: 'Widgets get a panel.',
            changes: ['A panel shows widgets'],
            verdict: 'must',
            verdictReason: 'New screen.',
            testCases: [],
            testing: [],
            autotests: [{ level: 'e2e', idea: 'Open the panel', testIds: ['widget-panel', 'x'] }],
            risks: [],
            questions: [],
          },
        } as never
      },
    })
    app = createApp(deps)
    await listed()
    expect((await call('POST', '/qa/summary', as('viewer'), { key: 'ABC-1' })).status).toBe(403)

    const response = await call('POST', '/qa/summary', as('admin'), { key: 'ABC-1' })
    expect(response.status).toBe(200)
    const summary = (await response.json()) as QaSummaryView
    expect(summary).toMatchObject({ changes: 2, by: { id: 'header:admin' } })
    expect(summary.sections.autotests[0]?.testIds).toEqual(['widget-panel'])
    expect(summary.stale).toBeUndefined()
    expect(prompts[0]).toContain('widget-panel')

    expect((await json<QaTaskView>('/qa/task?key=ABC-1')).summary?.stale).toBeUndefined()
    expect((await json<QaTaskList>('/qa/tasks?days=30')).tasks[1]?.summary).toBe('fresh')

    shapes.commit('main', 'fix: ABC-1 widget panel spacing', '+.panel { gap: 4px }')
    now = new Date(now.getTime() + 10 * 60_000)
    const list = await listed()
    expect(list.tasks.find((task) => task.key === 'ABC-1')?.summary).toBe('stale')
    const stale = (await json<QaTaskView>('/qa/task?key=ABC-1')).summary?.stale
    expect(stale?.added).toHaveLength(1)
    expect(stale?.added[0]).toStartWith('work:shapes/app@')
  })
})

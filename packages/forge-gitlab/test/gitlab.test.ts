import { describe, expect, test } from 'bun:test'

import type { GitForge, Repository } from '@holtkeeper/forge'

import { gitlab, GitLabApiError } from '../src/index.ts'
import { FakeGitLab, type FakeGitLabOptions } from './fake-gitlab.ts'

function setup(options: FakeGitLabOptions & { perPage?: number; retries?: number } = {}) {
  const server = new FakeGitLab(options)
  const definition = gitlab({
    url: options.url ?? server.base,
    token: server.token,
    fetch: server.fetch,
    perPage: options.perPage,
    retries: options.retries,
  })
  return { server, definition, forge: definition.create() }
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected a rejection')
}

async function collect(forge: GitForge, namespace: string): Promise<Repository[]> {
  const result: Repository[] = []
  for await (const repo of forge.listRepositories(namespace)) result.push(repo)
  return result
}

describe('definition', () => {
  test('has kind gitlab and resolves the token lazily', () => {
    const definition = gitlab({ url: 'https://gitlab.example.com', token: { env: 'HK_UNSET_X' } })
    expect(definition.kind).toBe('gitlab')
    expect(definition.url).toBe('https://gitlab.example.com')
    expect(() => definition.create()).toThrow('HK_UNSET_X')
  })

  test('rejects an invalid page size', () => {
    expect(() => gitlab({ url: 'https://g.example', token: 't', perPage: 500 }).create()).toThrow()
  })
})

describe('repositories', () => {
  test('lists group projects including subgroups across pages', async () => {
    const { server, forge } = setup({ perPage: 2 })
    server.addProject('games/a')
    server.addProject('games/sub/b', { archived: true })
    server.addProject('games/c')
    server.addProject('other/d')
    server.addProject('games/sub/deep/e')

    const repos = await collect(forge, 'games')
    expect(repos.map((r) => [r.path, r.archived])).toEqual([
      ['games/a', false],
      ['games/sub/b', true],
      ['games/c', false],
      ['games/sub/deep/e', false],
    ])
    expect(server.calls).toHaveLength(2)
    expect(server.calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/groups/games/projects?per_page=2&include_subgroups=true&with_shared=false&order_by=id&sort=asc',
    )
  })

  test('follows X-Next-Page when there is no Link header', async () => {
    const { server, forge } = setup({ perPage: 1, pagination: 'header' })
    server.addProject('g/a')
    server.addProject('g/b')
    server.addProject('g/c')
    expect((await collect(forge, 'g')).map((r) => r.path)).toEqual(['g/a', 'g/b', 'g/c'])
    expect(server.calls.at(-1)?.url).toContain('page=3')
  })

  test('falls back to a user namespace', async () => {
    const { server, forge } = setup()
    server.addUser('alice')
    server.addProject('alice/tool')
    expect((await collect(forge, 'alice')).map((r) => r.path)).toEqual(['alice/tool'])
    expect(server.calls[1]?.url).toStartWith(
      'https://gitlab.example.com/api/v4/users/alice/projects?',
    )
  })

  test('rejects next-page links outside the API root', async () => {
    const server = new FakeGitLab()
    server.addProject('g/a')
    const forge = gitlab({
      url: server.base,
      token: server.token,
      fetch: async (url, init) => {
        const response = await server.fetch(url, init)
        const headers = new Headers(response.headers)
        headers.set('Link', '<https://evil.example/steal>; rel="next"')
        return new Response(await response.text(), { status: response.status, headers })
      },
    }).create()
    const error = await errorOf(collect(forge, 'g'))
    expect(error).toBeInstanceOf(GitLabApiError)
    expect(error.message).toContain('foreign next-page link')
  })

  test('gets a project by URL-encoded full path', async () => {
    const { server, forge } = setup()
    server.addProject('games/sub/app')
    expect(await forge.getRepository('games/sub/app')).toEqual({
      path: 'games/sub/app',
      name: 'app',
      defaultBranch: 'main',
      webUrl: 'https://gitlab.example.com/games/sub/app',
      cloneUrl: 'https://gitlab.example.com/games/sub/app.git',
      archived: false,
    })
    const call = server.calls[0]
    expect(call?.url).toBe('https://gitlab.example.com/api/v4/projects/games%2Fsub%2Fapp')
    expect(call?.method).toBe('GET')
    expect(call?.redirect).toBe('error')
    expect(call?.headers).toEqual({ 'PRIVATE-TOKEN': server.token, Accept: 'application/json' })
  })

  test.each([
    ['https://example.com/gitlab', 'https://example.com/gitlab/api/v4/projects/g%2Fa'],
    ['https://example.com/gitlab/', 'https://example.com/gitlab/api/v4/projects/g%2Fa'],
    ['https://gitlab.example.com/', 'https://gitlab.example.com/api/v4/projects/g%2Fa'],
  ])('supports base URL %s', async (url, expected) => {
    const { server, forge } = setup({ url })
    server.addProject('g/a')
    await forge.getRepository('g/a')
    expect(server.calls[0]?.url).toBe(expected)
  })

  test('readFile returns contents, undefined for missing files and rejects missing projects', async () => {
    const { server, forge } = setup()
    server.addProject('g/a', { files: { 'src/config.json': '{"a":1}' } })
    expect(await forge.readFile('g/a', 'src/config.json')).toBe('{"a":1}')
    expect(server.calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fa/repository/files/src%2Fconfig.json/raw',
    )
    expect(await forge.readFile('g/a', 'missing.txt')).toBeUndefined()
    expect(await forge.readFile('g/a', 'src/config.json', 'nope')).toBeUndefined()
    const error = await errorOf(forge.readFile('g/missing', 'x'))
    expect(error).toBeInstanceOf(GitLabApiError)
    expect((error as GitLabApiError).status).toBe(404)
  })

  test('binary round trip: base64 commit, then readFileBytes returns the same bytes', async () => {
    const { server, definition } = setup()
    const forge = definition.create() as Required<GitForge>
    server.addProject('g/a')
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80])
    const content = Buffer.from(png).toString('base64')
    await forge.commit('g/a', {
      branch: 'main',
      message: 'add logo',
      changes: [
        { action: 'create', path: 'logo.png', content, encoding: 'base64' },
        { action: 'create', path: 'a.txt', content: 'plain', encoding: 'text' },
      ],
    })
    expect(server.calls.at(-1)?.body).toEqual({
      branch: 'main',
      commit_message: 'add logo',
      actions: [
        { action: 'create', file_path: 'logo.png', content, encoding: 'base64' },
        { action: 'create', file_path: 'a.txt', content: 'plain' },
      ],
    })
    expect(await forge.readFileBytes('g/a', 'logo.png')).toEqual(png)
    expect(await forge.readFileBytes('g/a', 'a.txt', 'main')).toEqual(
      new TextEncoder().encode('plain'),
    )
    expect(server.calls.at(-1)?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fa/repository/files/a.txt/raw?ref=main',
    )
    expect(await forge.readFileBytes('g/a', 'missing.png')).toBeUndefined()
    const error = await errorOf(forge.readFileBytes('g/missing', 'x'))
    expect((error as GitLabApiError).status).toBe(404)
  })
})

describe('branches and commits', () => {
  test('commit on a new branch, then readFile reflects it', async () => {
    const { server, forge } = setup()
    server.addProject('g/a', { files: { 'a.txt': 'old', 'gone.txt': 'x' } })

    const commit = await forge.commit('g/a', {
      branch: 'holtkeeper/update',
      startBranch: 'main',
      message: 'chore: update',
      changes: [
        { action: 'update', path: 'a.txt', content: 'new' },
        { action: 'create', path: 'dir/b.txt', content: 'b' },
        { action: 'delete', path: 'gone.txt' },
      ],
    })
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(commit.webUrl).toBe(`https://gitlab.example.com/g/a/-/commit/${commit.sha}`)

    const post = server.calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('https://gitlab.example.com/api/v4/projects/g%2Fa/repository/commits')
    expect(post?.headers['Content-Type']).toBe('application/json')
    expect(post?.body).toEqual({
      branch: 'holtkeeper/update',
      start_branch: 'main',
      commit_message: 'chore: update',
      actions: [
        { action: 'update', file_path: 'a.txt', content: 'new' },
        { action: 'create', file_path: 'dir/b.txt', content: 'b' },
        { action: 'delete', file_path: 'gone.txt' },
      ],
    })

    expect(await forge.readFile('g/a', 'a.txt', 'holtkeeper/update')).toBe('new')
    expect(await forge.readFile('g/a', 'dir/b.txt', 'holtkeeper/update')).toBe('b')
    expect(await forge.readFile('g/a', 'gone.txt', 'holtkeeper/update')).toBeUndefined()
    expect(await forge.readFile('g/a', 'a.txt')).toBe('old')
  })

  test('omits start_branch when the branch already exists', async () => {
    const { server, forge } = setup()
    server.addProject('g/a', { files: { 'a.txt': '1' } })
    await forge.createBranch('g/a', 'feature', 'main')
    expect(server.calls[0]?.body).toEqual({ branch: 'feature', ref: 'main' })

    await forge.commit('g/a', {
      branch: 'feature',
      startBranch: 'main',
      message: 'm',
      changes: [{ action: 'update', path: 'a.txt', content: '2' }],
    })
    expect(server.calls.at(-1)?.body).not.toHaveProperty('start_branch')
    expect(await forge.readFile('g/a', 'a.txt', 'feature')).toBe('2')
  })

  test('deletes a branch', async () => {
    const { server, forge } = setup()
    server.addProject('g/a')
    await forge.createBranch('g/a', 'feat/x', 'main')
    await forge.deleteBranch('g/a', 'feat/x')
    expect(server.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: 'https://gitlab.example.com/api/v4/projects/g%2Fa/repository/branches/feat%2Fx',
    })
    expect(server.projects.get('g/a')?.branches.has('feat/x')).toBe(false)
  })

  test('maps GitLab errors with status and message', async () => {
    const { server, forge } = setup()
    server.addProject('g/a', { files: { 'a.txt': '1' } })
    const error = await errorOf(
      forge.commit('g/a', {
        branch: 'main',
        message: 'm',
        changes: [{ action: 'create', path: 'a.txt', content: '2' }],
      }),
    )
    expect(error).toBeInstanceOf(GitLabApiError)
    expect((error as GitLabApiError).status).toBe(400)
    expect(error.message).toBe(
      'GitLab POST /api/v4/projects/g%2Fa/repository/commits failed with 400: A file with this name already exists',
    )
  })

  test('never puts the token into errors', async () => {
    const server = new FakeGitLab()
    const forge = gitlab({ url: server.base, token: 'wrong-token', fetch: server.fetch }).create()
    const error = await errorOf(forge.getRepository('g/a'))
    expect((error as GitLabApiError).status).toBe(401)
    expect(error.message).not.toContain('wrong-token')

    const echo = gitlab({
      url: server.base,
      token: 'secret-123',
      fetch: async () =>
        new Response(JSON.stringify({ message: 'bad secret-123' }), { status: 403 }),
    }).create()
    expect((await errorOf(echo.getRepository('g/a'))).message).toContain('bad [redacted]')
  })

  test('reports malformed responses by field', async () => {
    const forge = gitlab({
      url: 'https://g.example',
      token: 't',
      fetch: async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 }),
    }).create()
    const error = await errorOf(forge.getRepository('g/a'))
    expect(error).toBeInstanceOf(GitLabApiError)
    expect(error.message).toContain('unexpected response (path_with_namespace')
  })
})

describe('rate limiting', () => {
  test('retries a 429 once after Retry-After', async () => {
    const { server, forge } = setup()
    server.addProject('g/a')
    server.rateLimit = 1
    expect((await forge.getRepository('g/a')).path).toBe('g/a')
    expect(server.calls).toHaveLength(2)
  })

  test('gives up after the configured retries', async () => {
    const { server, forge } = setup({ retries: 2 })
    server.addProject('g/a')
    server.rateLimit = 3
    const error = await errorOf(forge.getRepository('g/a'))
    expect((error as GitLabApiError).status).toBe(429)
    expect(server.calls).toHaveLength(3)
  })
})

describe('merge requests', () => {
  test('lifecycle: create, find, update, comment, merge', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    const alice = server.addUser('alice')
    const bob = server.addUser('bob')
    await forge.createBranch('g/a', 'fix', 'main')

    const created = await forge.createMergeRequest('g/a', {
      sourceBranch: 'fix',
      targetBranch: 'main',
      title: 'fix: deps',
      description: 'body',
      labels: ['deps', 'security'],
      reviewers: ['alice', 'bob'],
      draft: true,
    })
    expect(created).toEqual({
      id: 1,
      title: 'Draft: fix: deps',
      description: 'body',
      sourceBranch: 'fix',
      targetBranch: 'main',
      state: 'open',
      draft: true,
      labels: ['deps', 'security'],
      author: 'holtkeeper-bot',
      webUrl: 'https://gitlab.example.com/g/a/-/merge_requests/1',
    })
    expect(
      server.calls.some((c) => c.url === 'https://gitlab.example.com/api/v4/users?username=alice'),
    ).toBe(true)
    const post = server.calls.find((c) => c.method === 'POST' && c.url.endsWith('/merge_requests'))
    expect(post?.body).toEqual({
      source_branch: 'fix',
      target_branch: 'main',
      title: 'Draft: fix: deps',
      description: 'body',
      labels: 'deps,security',
      reviewer_ids: [alice, bob],
    })

    expect(await forge.findMergeRequest('g/a', { sourceBranch: 'fix', state: 'open' })).toEqual(
      created,
    )
    expect(server.calls.at(-1)?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fa/merge_requests?source_branch=fix&state=opened&order_by=created_at&sort=desc&per_page=1',
    )
    expect(await forge.findMergeRequest('g/a', { sourceBranch: 'other' })).toBeUndefined()

    const ready = await forge.updateMergeRequest('g/a', 1, { draft: false, labels: ['deps'] })
    expect(ready.title).toBe('fix: deps')
    expect(ready.draft).toBe(false)
    expect(ready.labels).toEqual(['deps'])

    const renamed = await forge.updateMergeRequest('g/a', 1, { title: 'fix: all deps' })
    expect(renamed.title).toBe('fix: all deps')

    const closed = await forge.updateMergeRequest('g/a', 1, { state: 'closed' })
    expect(closed.state).toBe('closed')
    expect(server.calls.at(-1)?.body).toEqual({ state_event: 'close' })
    expect(
      await forge.findMergeRequest('g/a', { sourceBranch: 'fix', state: 'open' }),
    ).toBeUndefined()
    expect((await forge.updateMergeRequest('g/a', 1, { state: 'open' })).state).toBe('open')

    await forge.commentOnMergeRequest('g/a', 1, 'Looks good')
    expect(project.mergeRequests[0]?.notes).toEqual(['Looks good'])
    expect(server.calls.at(-1)?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fa/merge_requests/1/notes',
    )

    await forge.mergeMergeRequest('g/a', 1, { squash: true, removeSourceBranch: true })
    expect(server.calls.at(-1)).toMatchObject({
      method: 'PUT',
      url: 'https://gitlab.example.com/api/v4/projects/g%2Fa/merge_requests/1/merge',
      body: { squash: true, should_remove_source_branch: true },
    })
    expect((await forge.findMergeRequest('g/a', { sourceBranch: 'fix' }))?.state).toBe('merged')
  })

  test('merge when pipeline succeeds sends both flags', async () => {
    const { server, forge } = setup()
    server.addProject('g/a')
    await forge.createBranch('g/a', 'fix', 'main')
    await forge.createMergeRequest('g/a', { sourceBranch: 'fix', targetBranch: 'main', title: 't' })
    await forge.mergeMergeRequest('g/a', 1, { whenPipelineSucceeds: true })
    expect(server.calls.at(-1)?.body).toEqual({
      merge_when_pipeline_succeeds: true,
      auto_merge: true,
    })
  })

  test('fails on unknown reviewers before creating anything', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    await forge.createBranch('g/a', 'fix', 'main')
    const error = await errorOf(
      forge.createMergeRequest('g/a', {
        sourceBranch: 'fix',
        targetBranch: 'main',
        title: 't',
        reviewers: ['ghost'],
      }),
    )
    expect(error.message).toContain('ghost')
    expect(project.mergeRequests).toHaveLength(0)
  })
})

describe('pipelines, jobs and tags', () => {
  test('lists pipelines and jobs with normalized statuses, plays and retries jobs', async () => {
    const { server, forge } = setup({ perPage: 2 })
    const project = server.addProject('g/a')
    server.addPipeline(project, 'main', 'success', [])
    const pipeline = server.addPipeline(project, 'main', 'waiting_for_resource', [
      ['build', 'build', 'success'],
      ['test', 'test', 'preparing'],
      ['deploy', 'deploy', 'manual'],
      ['notify', 'deploy', 'scheduled'],
      ['lint', 'test', 'canceling'],
    ])

    const pipelines = await forge.listPipelines('g/a', { ref: 'main' })
    expect(pipelines.map((p) => p.status)).toEqual(['pending', 'success'])
    expect(pipelines[0]).toEqual({
      id: pipeline.id,
      ref: 'main',
      sha: pipeline.sha,
      status: 'pending',
      webUrl: `https://gitlab.example.com/g/a/-/pipelines/${pipeline.id}`,
    })
    expect(server.calls.at(-1)?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fa/pipelines?ref=main&per_page=2',
    )
    expect(await forge.listPipelines('g/a', { sha: 'nope' })).toEqual([])

    const jobs = await forge.listJobs('g/a', pipeline.id)
    expect(jobs.map((j) => [j.name, j.stage, j.status])).toEqual([
      ['build', 'build', 'success'],
      ['test', 'test', 'pending'],
      ['deploy', 'deploy', 'manual'],
      ['notify', 'deploy', 'pending'],
      ['lint', 'test', 'canceled'],
    ])

    const deploy = jobs[2]!
    const played = await forge.playJob('g/a', deploy.id)
    expect(played.status).toBe('pending')
    expect(server.calls.at(-1)).toMatchObject({
      method: 'POST',
      url: `https://gitlab.example.com/api/v4/projects/g%2Fa/jobs/${deploy.id}/play`,
    })

    const retried = await forge.retryJob('g/a', jobs[0]!.id)
    expect(retried.id).not.toBe(jobs[0]!.id)
    expect(retried.name).toBe('build')

    expect(((await errorOf(forge.playJob('g/a', jobs[0]!.id))) as GitLabApiError).status).toBe(400)
  })

  test('creates a tag', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    const tag = await forge.createTag('g/a', { name: 'v1.0.0', ref: 'main', message: 'Release' })
    expect(tag).toEqual({ name: 'v1.0.0', sha: project.branches.get('main')!.sha })
    expect(server.calls[0]?.body).toEqual({ tag_name: 'v1.0.0', ref: 'main', message: 'Release' })
  })

  test('lists commits of a range, newest first, up to the limit', async () => {
    const { server, forge } = setup({ perPage: 2 })
    const project = server.addProject('g/a')
    server.addCommits(project, 'main', ['feat: one'])
    server.addTag(project, 'v1.0.0', { committed_date: '2026-01-01T00:00:00Z' })
    server.addCommits(project, 'development', ['fix: two', 'feat(ui): three\n\nBody text'])

    const commits = await forge.listCommits!('g/a', { ref: 'development', since: 'v1.0.0' })
    expect(commits.map((c) => [c.title, c.parents.length])).toEqual([
      ['feat(ui): three', 1],
      ['fix: two', 1],
    ])
    expect(commits[0]).toMatchObject({
      message: 'feat(ui): three\n\nBody text',
      authorName: 'Fake User',
    })
    expect(server.calls.at(-1)?.url).toContain('ref_name=v1.0.0..development')
    expect(await forge.listCommits!('g/a', { ref: 'development', limit: 1 })).toHaveLength(1)
    expect(
      ((await errorOf(forge.listCommits!('g/a', { ref: 'nope' }))) as GitLabApiError).status,
    ).toBe(404)
  })

  test('reads push rules', async () => {
    const { server, forge } = setup()
    server.addProject('g/a')
    server.addProject('g/b')
    server.addProject('g/c')
    server.pushRules.set('g/a', {
      commit_message_regex: '^(feat|fix): ',
      commit_message_negative_regex: '',
      branch_name_regex: '^(feat|fix)/',
    })
    server.pushRules.set('g/b', { commit_message_regex: null })
    expect(await forge.getPushRules!('g/a')).toEqual({
      commitMessage: '^(feat|fix): ',
      branchName: '^(feat|fix)/',
    })
    expect(await forge.getPushRules!('g/b')).toBeUndefined()
    expect(await forge.getPushRules!('g/c')).toBeUndefined()
  })

  test('creates, reads and updates releases', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    await forge.createTag('g/a', { name: 'v1.0.0', ref: 'main' })
    expect(await forge.getRelease!('g/a', 'v1.0.0')).toBeUndefined()
    const created = await forge.createRelease!('g/a', {
      tag: 'v1.0.0',
      name: 'v1.0.0',
      description: 'Notes',
    })
    expect(created).toEqual({
      tag: 'v1.0.0',
      name: 'v1.0.0',
      description: 'Notes',
      webUrl: 'https://gitlab.example.com/g/a/-/releases/v1.0.0',
    })
    const updated = await forge.updateRelease!('g/a', { tag: 'v1.0.0', description: 'Better' })
    expect(updated.description).toBe('Better')
    expect(project.releases.get('v1.0.0')?.name).toBe('v1.0.0')
    expect((await forge.getRelease!('g/a', 'v1.0.0'))?.description).toBe('Better')
  })
})

describe('git credentials', () => {
  test('returns oauth2 and the resolved token', () => {
    const definition = gitlab({ url: 'https://g.example', token: 'glpat-x' })
    expect(definition.gitCredentials?.()).toEqual({ username: 'oauth2', password: 'glpat-x' })
  })
})

describe('insight reads', () => {
  test('lists merge requests with timestamps, newest update first, up to the limit', async () => {
    const { server, forge } = setup({ perPage: 2 })
    const project = server.addProject('g/a')
    server.addMergeRequest(project, {
      title: 'old',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    })
    server.addMergeRequest(project, {
      title: 'Draft: wip',
      labels: ['hotfix'],
      created_at: '2026-03-01T00:00:00Z',
      updated_at: '2026-03-05T00:00:00Z',
    })
    server.addMergeRequest(project, {
      title: 'merged',
      state: 'merged',
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-03-04T00:00:00Z',
      merged_at: '2026-03-04T00:00:00Z',
    })
    server.addMergeRequest(project, {
      title: 'closed',
      state: 'closed',
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-03-03T00:00:00Z',
      closed_at: '2026-03-03T00:00:00Z',
    })

    const list = await forge.listMergeRequests?.('g/a', { updatedAfter: '2026-02-01T00:00:00Z' })
    expect(list?.map((mr) => mr.title)).toEqual(['Draft: wip', 'merged', 'closed'])
    expect(list?.[0]).toMatchObject({ draft: true, labels: ['hotfix'], author: 'dev' })
    expect(list?.[1]).toMatchObject({ state: 'merged', mergedAt: '2026-03-04T00:00:00Z' })
    expect(list?.[1]?.closedAt).toBeUndefined()
    expect(list?.[2]).toMatchObject({ state: 'closed', closedAt: '2026-03-03T00:00:00Z' })
    expect(server.calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fa/merge_requests?per_page=2&state=all&updated_after=2026-02-01T00%3A00%3A00Z&order_by=updated_at&sort=desc',
    )

    server.calls.length = 0
    const open = await forge.listMergeRequests?.('g/a', { state: 'open', limit: 1 })
    expect(open?.map((mr) => mr.title)).toEqual(['Draft: wip'])
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]?.url).toContain('state=opened')
    expect(server.calls[0]?.url).toContain('per_page=1')
  })

  test('lists pipeline runs with timing from the single-pipeline endpoint', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    server.addPipeline(project, 'main', 'success', [], {
      created_at: '2026-01-01T00:00:00Z',
    })
    server.addPipeline(project, 'main', 'failed', [], {
      created_at: '2026-02-01T10:00:00Z',
      started_at: '2026-02-01T10:01:00Z',
      finished_at: '2026-02-01T10:11:00Z',
      duration: 600,
      queued_duration: 60.5,
      source: 'merge_request_event',
    })
    server.addPipeline(project, 'main', 'running', [], { created_at: '2026-02-02T00:00:00Z' })

    const runs = await forge.listPipelineRuns?.('g/a', {
      ref: 'main',
      after: '2026-02-01T00:00:00Z',
    })
    expect(runs?.map((run) => run.status)).toEqual(['running', 'failed'])
    expect(runs?.[1]).toMatchObject({
      createdAt: '2026-02-01T10:00:00Z',
      startedAt: '2026-02-01T10:01:00Z',
      finishedAt: '2026-02-01T10:11:00Z',
      durationSeconds: 600,
      queuedSeconds: 60.5,
      source: 'merge_request_event',
    })
    expect(runs?.[0]?.durationSeconds).toBeUndefined()
    expect(server.calls[0]?.url).toContain('created_after=2026-02-01T00%3A00%3A00Z')
    expect(server.calls.filter((c) => /\/pipelines\/\d+$/.test(c.url))).toHaveLength(2)

    expect(await forge.listPipelineRuns?.('g/a', { limit: 1 })).toHaveLength(1)
  })

  test('lists job runs including retried attempts', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    const pipeline = server.addPipeline(project, 'main', 'success', [
      ['test', 'test', 'failed', { duration: 30, queued_duration: 2 }],
      ['lint', 'test', 'failed', { allow_failure: true }],
    ])
    const first = project.jobs[0]
    if (!first) throw new Error('missing job')
    const retried = await forge.retryJob('g/a', first.id)
    const retriedJob = project.jobs.find((j) => j.id === retried.id)
    if (retriedJob) retriedJob.status = 'success'

    const jobs = await forge.listJobRuns?.('g/a', pipeline.id)
    expect(jobs?.map((j) => [j.name, j.status, j.retried, j.allowFailure])).toEqual([
      ['test', 'failed', true, false],
      ['lint', 'failed', false, true],
      ['test', 'success', false, false],
    ])
    expect(jobs?.[0]).toMatchObject({
      pipelineId: pipeline.id,
      durationSeconds: 30,
      queuedSeconds: 2,
    })
    expect(server.calls.at(-1)?.url).toContain('include_retried=true')
  })

  test('lists project job runs newest first until the first job older than after', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    server.addPipeline(
      project,
      'main',
      'success',
      [['old', 'test', 'success', { created_at: '2026-01-01T00:00:00Z' }]],
      { sha: 'aaa' },
    )
    const pipeline = server.addPipeline(
      project,
      'main',
      'success',
      [
        ['test', 'test', 'failed', { created_at: '2026-02-02T00:00:00Z', duration: 30 }],
        ['build', 'build', 'success', { created_at: '2026-02-02T00:00:00Z' }],
      ],
      { sha: 'bbb' },
    )
    const first = project.jobs.find((j) => j.name === 'test')
    if (!first) throw new Error('missing job')
    await forge.retryJob('g/a', first.id)
    const retry = project.jobs.at(-1)
    if (retry) Object.assign(retry, { status: 'success', created_at: '2026-02-02T00:10:00Z' })

    const jobs = await forge.listProjectJobRuns?.('g/a', { after: '2026-02-01T00:00:00Z' })
    expect(jobs?.map((j) => [j.name, j.status, j.retried])).toEqual([
      ['test', 'success', false],
      ['build', 'success', false],
      ['test', 'failed', true],
    ])
    expect(jobs?.[2]).toMatchObject({
      pipelineId: pipeline.id,
      ref: 'main',
      sha: 'bbb',
      durationSeconds: 30,
    })
    expect(await forge.listProjectJobRuns?.('g/a', { limit: 2 })).toHaveLength(2)
    expect(jobs?.some((j) => j.tag)).toBe(false)

    server.addPipeline(project, 'v1.0.0', 'success', [
      ['release', 'deploy', 'success', { created_at: '2026-02-03T00:00:00Z' }],
    ])
    const [tagged] = (await forge.listProjectJobRuns?.('g/a', { limit: 1 })) ?? []
    expect(tagged).toMatchObject({ name: 'release', ref: 'v1.0.0', tag: true })
  })

  test('reads the project avatar, else the nearest group avatar', async () => {
    const { server, forge } = setup()
    server.addProject('g/sub/a')
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])
    expect(await forge.getRepositoryAvatar?.('g/sub/a')).toBeUndefined()
    server.setAvatar('groups', 'g', png)
    expect(await forge.getRepositoryAvatar?.('g/sub/a')).toEqual({
      data: png,
      contentType: 'image/png',
    })
    expect(server.calls.at(-1)?.url).toContain('/groups/g/avatar')
    server.setAvatar('projects', 'g/sub/a', png)
    await forge.getRepositoryAvatar?.('g/sub/a')
    expect(server.calls.at(-1)?.url).toContain('/projects/g%2Fsub%2Fa/avatar')
  })

  test('lists CI/CD variables without masked, hidden or file ones and skips denied scopes', async () => {
    const { server, forge } = setup()
    server.addProject('g/sub/a')
    server.setCiVariables('projects', 'g/sub/a', [
      {
        key: 'IMAGE',
        value: 'node:22',
        variable_type: 'env_var',
        masked: false,
        environment_scope: '*',
      },
      {
        key: 'TOKEN',
        value: 'secret',
        variable_type: 'env_var',
        masked: true,
        environment_scope: '*',
      },
      { key: 'HIDDEN', value: null, variable_type: 'env_var', masked: true, hidden: true },
      { key: 'KUBECONFIG', value: 'apiVersion: v1', variable_type: 'file', masked: false },
    ])
    server.setCiVariables('groups', 'g', 'denied')
    expect(await forge.listCiVariables?.({ kind: 'repo', path: 'g/sub/a' })).toEqual([
      { key: 'IMAGE', value: 'node:22', environmentScope: '*' },
    ])
    expect(await forge.listCiVariables?.({ kind: 'group', path: 'g' })).toBeUndefined()
    expect(await forge.listCiVariables?.({ kind: 'group', path: 'g/sub' })).toBeUndefined()
    expect(server.calls.at(-1)?.url).toContain('/groups/g%2Fsub/variables')
  })

  test('lists registry tags from the longest project path that has the image', async () => {
    const { server, forge } = setup()
    server.registry.set('g/images', [
      { location: 'registry.example.com/g/images/bun-1-3', tags: ['latest', '1.3.2'] },
    ])
    expect(await forge.listImageTags?.('registry.example.com/g/images/bun-1-3')).toEqual([
      'latest',
      '1.3.2',
    ])
    expect(server.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v4/projects/g%2Fimages%2Fbun-1-3/registry/repositories',
      '/api/v4/projects/g%2Fimages/registry/repositories',
    ])
    expect(await forge.listImageTags?.('ghcr.io/g/images/bun-1-3')).toBeUndefined()
  })

  test('lists deployments by environment, ordered by update when filtered by time', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    server.addDeployment(project, { status: 'success', created_at: '2026-01-01T00:00:00Z' })
    server.addDeployment(project, {
      status: 'failed',
      created_at: '2026-02-02T00:00:00Z',
      finished_at: '2026-02-02T00:10:00Z',
    })
    server.addDeployment(project, { status: 'created', created_at: '2026-02-03T00:00:00Z' })
    server.addDeployment(project, {
      status: 'success',
      environment: 'staging',
      created_at: '2026-02-04T00:00:00Z',
    })

    const list = await forge.listDeployments?.('g/a', {
      environment: 'production',
      after: '2026-02-01T00:00:00Z',
    })
    expect(list?.map((d) => d.status)).toEqual(['pending', 'failed'])
    expect(list?.[1]).toMatchObject({
      environment: 'production',
      ref: 'main',
      createdAt: '2026-02-02T00:00:00Z',
      finishedAt: '2026-02-02T00:10:00Z',
    })
    expect(server.calls[0]?.url).toContain('order_by=updated_at')

    const all = await forge.listDeployments?.('g/a')
    expect(all).toHaveLength(4)
    expect(server.calls.at(-1)?.url).toContain('order_by=id')
  })

  test('lists tags with commit dates', async () => {
    const { server, forge } = setup()
    const project = server.addProject('g/a')
    server.addTag(project, 'v1.0.0', { committed_date: '2026-01-01T00:00:00Z' })
    server.addTag(project, 'v1.1.0', {
      committed_date: '2026-02-01T00:00:00Z',
      created_at: '2026-02-01T01:00:00Z',
    })
    const tags = await forge.listTags?.('g/a', { limit: 5 })
    expect(tags).toEqual([
      {
        name: 'v1.1.0',
        sha: expect.any(String),
        committedAt: '2026-02-01T00:00:00Z',
        createdAt: '2026-02-01T01:00:00Z',
      },
      { name: 'v1.0.0', sha: expect.any(String), committedAt: '2026-01-01T00:00:00Z' },
    ])
    expect(server.calls[0]?.url).toContain('repository/tags?per_page=5&order_by=updated&sort=desc')
  })
})

describe('listBranches', () => {
  test('lists every branch with its head commit, following pages', async () => {
    const { server, forge } = setup({ perPage: 1 })
    const project = server.addProject('g/a')
    server.addBranch(project, 'feature/x', {
      committed_date: '2026-03-01T00:00:00Z',
      author_name: 'Ann',
      merged: true,
    })
    const branches = await forge.listBranches?.('g/a')
    expect(branches).toEqual([
      {
        name: 'main',
        sha: expect.any(String),
        committedAt: '2026-01-01T00:00:00.000Z',
        authorName: 'Fake User',
        merged: false,
        protected: true,
        default: true,
        webUrl: expect.stringContaining('g/a/-/tree/main'),
      },
      {
        name: 'feature/x',
        sha: expect.any(String),
        committedAt: '2026-03-01T00:00:00Z',
        authorName: 'Ann',
        merged: true,
        protected: false,
        default: false,
        webUrl: expect.stringContaining('g/a/-/tree/feature/x'),
      },
    ])
    expect(server.calls).toHaveLength(2)
  })
})

describe('listFiles', () => {
  const files = {
    'package.json': '{}',
    'apps/web/package.json': '{}',
    'apps/web/src/index.ts': '',
    'packages/core/package.json': '{}',
  }

  test('lists direct children, or the subtree with recursive, following pages', async () => {
    const { server, forge } = setup({ perPage: 2 })
    server.addProject('g/a', { files })
    expect(await forge.listFiles?.('g/a')).toEqual([
      { path: 'apps', type: 'dir' },
      { path: 'package.json', type: 'file' },
      { path: 'packages', type: 'dir' },
    ])
    expect(server.calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fa/repository/tree?per_page=2&recursive=false&pagination=keyset',
    )
    const apps = await forge.listFiles?.('g/a', { path: 'apps', recursive: true, ref: 'main' })
    expect(apps).toEqual([
      { path: 'apps/web', type: 'dir' },
      { path: 'apps/web/package.json', type: 'file' },
      { path: 'apps/web/src', type: 'dir' },
      { path: 'apps/web/src/index.ts', type: 'file' },
    ])
  })

  test('caps by limit and returns nothing for missing paths or refs', async () => {
    const { server, forge } = setup()
    server.addProject('g/a', { files })
    expect(await forge.listFiles?.('g/a', { recursive: true, limit: 3 })).toHaveLength(3)
    expect(server.calls[0]?.url).toContain('per_page=3')
    expect(await forge.listFiles?.('g/a', { path: 'nope' })).toEqual([])
    expect(await forge.listFiles?.('g/a', { ref: 'nope' })).toEqual([])
    const error = await errorOf(forge.listFiles?.('g/missing') ?? Promise.resolve())
    expect(error).toBeInstanceOf(GitLabApiError)
  })
})

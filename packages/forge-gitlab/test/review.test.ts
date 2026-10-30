import { describe, expect, test } from 'bun:test'

import type { GitForge, ReviewComment } from '@holtkeeper/forge'

import { gitlab, GitLabApiError } from '../src/index.ts'
import { FakeGitLab, type FakeDiff, type FakeGitLabOptions } from './fake-gitlab.ts'

const SHA_APP = '216381173f187cf4c2baf119193855699f4bc616'
const API = 'https://gitlab.example.com/api/v4/projects/g%2Fa/merge_requests/1'

const APP_DIFF = [
  '@@ -1,4 +1,5 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' const d = 5',
  ' const e = 6',
  '',
].join('\n')

const DIFFS: FakeDiff[] = [
  { old_path: 'src/app.ts', new_path: 'src/app.ts', diff: APP_DIFF },
  {
    old_path: 'docs/new.md',
    new_path: 'docs/new.md',
    diff: '@@ -0,0 +1 @@\n+hi\n',
    new_file: true,
  },
  { old_path: 'gone.txt', new_path: 'gone.txt', diff: '@@ -1 +0,0 @@\n-bye\n', deleted_file: true },
  { old_path: 'old/name.ts', new_path: 'new/name.ts', diff: '', renamed_file: true },
  {
    old_path: 'logo.png',
    new_path: 'logo.png',
    diff: 'Binary files a/logo.png and b/logo.png differ\n',
  },
  { old_path: 'big.json', new_path: 'big.json', diff: '', too_large: true },
]

function setup(options: FakeGitLabOptions & { perPage?: number } = {}) {
  const server = new FakeGitLab(options)
  const forge = gitlab({
    url: server.base,
    token: server.token,
    fetch: server.fetch,
    perPage: options.perPage,
  }).create() as Required<GitForge>
  const project = server.addProject('g/a')
  const mr = server.addMergeRequest(project, { title: 'feat: x' })
  return { server, forge, project, mr }
}

describe('merge request and diff', () => {
  test('getMergeRequest returns the head sha', async () => {
    const { server, forge, mr } = setup()
    const version = server.addVersion(mr, DIFFS)
    const result = await forge.getMergeRequest('g/a', 1)
    expect(result.headSha).toBe(version.head_commit_sha)
    expect(result.title).toBe('feat: x')
  })

  test('getMergeRequestDiff reads the latest version with statuses and flags', async () => {
    const { server, forge, mr } = setup({ perPage: 1 })
    server.addVersion(mr, [])
    const latest = server.addVersion(mr, DIFFS)
    const diff = await forge.getMergeRequestDiff('g/a', 1)
    expect(diff.refs).toEqual({
      baseSha: latest.base_commit_sha,
      startSha: latest.start_commit_sha,
      headSha: latest.head_commit_sha,
    })
    expect(diff.files).toEqual([
      { oldPath: 'src/app.ts', newPath: 'src/app.ts', status: 'modified', diff: APP_DIFF },
      {
        oldPath: 'docs/new.md',
        newPath: 'docs/new.md',
        status: 'added',
        diff: '@@ -0,0 +1 @@\n+hi\n',
      },
      {
        oldPath: 'gone.txt',
        newPath: 'gone.txt',
        status: 'deleted',
        diff: '@@ -1 +0,0 @@\n-bye\n',
      },
      { oldPath: 'old/name.ts', newPath: 'new/name.ts', status: 'renamed', diff: '' },
      {
        oldPath: 'logo.png',
        newPath: 'logo.png',
        status: 'modified',
        diff: 'Binary files a/logo.png and b/logo.png differ\n',
        binary: true,
      },
      { oldPath: 'big.json', newPath: 'big.json', status: 'modified', diff: '', collapsed: true },
    ])
    const urls = server.calls.map((c) => c.url)
    expect(urls.filter((u) => u.includes('/versions?'))).toHaveLength(2)
    expect(urls.at(-1)).toBe(`${API}/versions/${latest.id}`)
  })

  test('falls back to diff_refs and paginated /diffs before the first version exists', async () => {
    const { server, mr } = setup()
    server.addVersion(mr, DIFFS)
    const versions = mr.versions
    const realFetch = server.fetch
    const forgeWithoutVersions = gitlab({
      url: server.base,
      token: server.token,
      perPage: 2,
      fetch: async (url, init) =>
        url.includes('/versions?')
          ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
          : realFetch(url, init),
    }).create() as Required<GitForge>
    const diff = await forgeWithoutVersions.getMergeRequestDiff('g/a', 1)
    expect(diff.refs.headSha).toBe(versions[0]?.head_commit_sha ?? '')
    expect(diff.files.map((f) => f.newPath)).toEqual(DIFFS.map((d) => d.new_path))
    expect(server.calls.filter((c) => c.url.includes('/diffs?'))).toHaveLength(3)
  })

  test('compareCommits compares the two commits directly', async () => {
    const { server, forge } = setup()
    server.compares.set('aaa..bbb', [DIFFS[0] as FakeDiff])
    const files = await forge.compareCommits('g/a', 'aaa', 'bbb')
    expect(files.map((f) => f.newPath)).toEqual(['src/app.ts'])
    expect(server.calls.at(-1)?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fa/repository/compare?from=aaa&to=bbb&straight=true',
    )
  })
})

describe('discussions', () => {
  test('lists all pages and maps positions and resolution', async () => {
    const { server, forge, mr } = setup({ perPage: 1 })
    const position = {
      position_type: 'text',
      base_sha: 'b',
      start_sha: 's',
      head_sha: 'h1',
      old_path: 'src/app.ts',
      new_path: 'src/app.ts',
      old_line: 3,
      new_line: 4,
    }
    server.addDiscussion(mr, [{ body: 'general' }])
    const onLine = server.addDiscussion(mr, [
      { body: 'fix', position, resolvable: true, resolved: true },
      { body: 'done', resolvable: true, resolved: true, author: { username: 'dev' } },
    ])
    server.addDiscussion(mr, [
      { body: 'removed', resolvable: true, position: { ...position, new_line: null, old_line: 2 } },
    ])
    const discussions = await forge.listDiscussions('g/a', 1)
    expect(discussions).toHaveLength(3)
    expect(discussions[0]).toMatchObject({ resolvable: false, resolved: false })
    expect(discussions[0]?.position).toBeUndefined()
    expect(discussions[1]).toEqual({
      id: onLine.id,
      resolvable: true,
      resolved: true,
      notes: onLine.notes.map((n) => ({
        id: n.id,
        author: n.author.username,
        body: n.body,
        createdAt: n.created_at,
        system: false,
      })),
      position: { path: 'src/app.ts', line: 4, side: 'new', headSha: 'h1' },
    })
    expect(discussions[2]).toMatchObject({
      resolved: false,
      position: { path: 'src/app.ts', line: 2, side: 'old' },
    })
    expect(server.calls).toHaveLength(3)
  })

  test('replies to and resolves a discussion', async () => {
    const { server, forge, mr } = setup()
    const discussion = server.addDiscussion(mr, [{ body: 'q', resolvable: true }])
    await forge.replyToDiscussion('g/a', 1, discussion.id, 'answer')
    expect(server.calls.at(-1)).toMatchObject({
      method: 'POST',
      url: `${API}/discussions/${discussion.id}/notes`,
      body: { body: 'answer' },
    })
    await forge.resolveDiscussion('g/a', 1, discussion.id, true)
    expect(server.calls.at(-1)).toMatchObject({
      method: 'PUT',
      url: `${API}/discussions/${discussion.id}?resolved=true`,
    })
    expect(discussion.notes[0]?.resolved).toBe(true)
    expect(discussion.notes.at(-1)?.body).toBe('answer')
    await forge.resolveDiscussion('g/a', 1, discussion.id, false)
    expect(discussion.notes[0]?.resolved).toBe(false)
  })
})

const draftBodies = (server: FakeGitLab) =>
  server.calls
    .filter((c) => c.method === 'POST' && c.url === `${API}/draft_notes`)
    .map((c) => c.body)

describe('submitReview', () => {
  const comments: ReviewComment[] = [
    { path: 'src/app.ts', line: 3, body: 'Name it better' },
    {
      path: 'src/app.ts',
      line: 4,
      startLine: 2,
      body: 'Merge these',
      suggestion: { replacement: 'const bc = 34\nconst d = 5\n' },
    },
    { path: 'src/app.ts', line: 2, side: 'old', body: 'Why removed?' },
    { path: 'docs/new.md', line: 1, body: 'Docs', suggestion: { replacement: '```sh\nhi\n```' } },
  ]
  const outside: ReviewComment = { path: 'src/app.ts', line: 50, body: 'Not in the diff' }
  const unknown: ReviewComment = { path: 'nope.ts', line: 1, body: 'Unknown file' }

  test('creates one draft per comment with exact positions and publishes them at once', async () => {
    const { server, forge, mr } = setup()
    const version = server.addVersion(mr, DIFFS)
    const refs = {
      baseSha: version.base_commit_sha,
      startSha: version.start_commit_sha,
      headSha: version.head_commit_sha,
    }
    const shas = {
      position_type: 'text',
      base_sha: refs.baseSha,
      start_sha: refs.startSha,
      head_sha: refs.headSha,
    }
    const app = { ...shas, old_path: 'src/app.ts', new_path: 'src/app.ts' }

    const outcome = await forge.submitReview('g/a', 1, {
      refs,
      comments: [...comments, outside, unknown, { path: 'a', line: 3, startLine: 4, body: '' }],
      summary: 'Overall fine',
      event: 'request_changes',
    })

    expect(draftBodies(server)).toEqual([
      { note: 'Overall fine' },
      { note: 'Name it better', position: { ...app, new_line: 3 } },
      {
        note: 'Merge these\n\n```suggestion:-2+0\nconst bc = 34\nconst d = 5\n```',
        position: {
          ...app,
          old_line: 3,
          new_line: 4,
          line_range: {
            start: { line_code: `${SHA_APP}_3_2`, type: 'new', new_line: 2 },
            end: { line_code: `${SHA_APP}_3_4`, type: 'old', old_line: 3, new_line: 4 },
          },
        },
      },
      { note: 'Why removed?', position: { ...app, old_line: 2 } },
      {
        note: 'Docs\n\n````suggestion:-0+0\n```sh\nhi\n```\n````',
        position: { ...shas, old_path: 'docs/new.md', new_path: 'docs/new.md', new_line: 1 },
      },
      { note: 'Not in the diff', position: { ...app, old_line: 49, new_line: 50 } },
    ])
    expect(outcome.posted).toBe(4)
    expect(outcome.failed.map((f) => [f.comment.body, f.error])).toEqual([
      ['', 'startLine is after line'],
      ['Not in the diff', expect.stringContaining('failed with 400')],
      ['Unknown file', 'nope.ts is not part of the merge request diff'],
    ])
    const publish = server.calls.filter((c) => c.url.endsWith('/bulk_publish'))
    expect(publish.map((c) => c.body)).toEqual([{ reviewer_state: 'requested_changes' }])
    expect(mr.drafts).toEqual([])
    expect(mr.discussions.map((d) => d.notes[0]?.body)).toEqual([
      'Overall fine',
      'Name it better',
      expect.stringContaining('Merge these'),
      'Why removed?',
      expect.stringContaining('Docs'),
    ])
    expect(mr.reviewerStates).toEqual(['requested_changes'])
    expect(mr.approvals).toEqual([])
  })

  test('positions against the version matching the review refs', async () => {
    const { server, forge, mr } = setup()
    const reviewed = server.addVersion(mr, DIFFS)
    server.addVersion(mr, [{ old_path: 'x', new_path: 'x', diff: '@@ -1 +1 @@\n-a\n+b\n' }])
    const outcome = await forge.submitReview('g/a', 1, {
      refs: {
        baseSha: reviewed.base_commit_sha,
        startSha: reviewed.start_commit_sha,
        headSha: reviewed.head_commit_sha,
      },
      comments: [{ path: 'src/app.ts', line: 3, body: 'ok' }],
    })
    expect(outcome).toEqual({ posted: 1, failed: [] })
    expect(server.calls.some((c) => c.url.endsWith(`/versions/${reviewed.id}`))).toBe(true)
    expect(server.calls.find((c) => c.url.endsWith('/bulk_publish'))?.body).toEqual({})
  })

  test('when bulk publish fails, publishes one by one and deletes rejected drafts', async () => {
    const { server, forge, mr } = setup({ rejectInvalidDrafts: 'publish' })
    const version = server.addVersion(mr, DIFFS)
    const outcome = await forge.submitReview('g/a', 1, {
      refs: {
        baseSha: version.base_commit_sha,
        startSha: version.start_commit_sha,
        headSha: version.head_commit_sha,
      },
      comments: [comments[0] as ReviewComment, outside],
      summary: 'Sum',
    })
    expect(outcome.posted).toBe(1)
    expect(outcome.failed).toEqual([
      { comment: outside, error: expect.stringContaining('/publish failed with 400') },
    ])
    const methods = server.calls
      .filter((c) => c.url.includes('/draft_notes/'))
      .map((c) => `${c.method} ${c.url.replace(/.*draft_notes\//, '')}`)
    expect(methods.map((m) => m.replace(/\d+/, 'N'))).toEqual([
      'POST bulk_publish',
      'PUT N/publish',
      'PUT N/publish',
      'DELETE N',
      'PUT N/publish',
    ])
    expect(mr.drafts).toEqual([])
    expect(mr.discussions.map((d) => d.notes[0]?.body)).toEqual(['Name it better', 'Sum'])
  })

  test('approve sends the head sha first; a refused approval posts nothing', async () => {
    const { server, forge, mr } = setup()
    const version = server.addVersion(mr, DIFFS)
    const refs = {
      baseSha: version.base_commit_sha,
      startSha: version.start_commit_sha,
      headSha: version.head_commit_sha,
    }
    const outcome = await forge.submitReview('g/a', 1, {
      refs,
      comments: [],
      event: 'approve',
    })
    expect(outcome).toEqual({ posted: 0, failed: [] })
    expect(server.calls.at(-1)).toMatchObject({
      method: 'POST',
      url: `${API}/approve`,
      body: { sha: refs.headSha },
    })
    expect(mr.approvals).toEqual([{ sha: refs.headSha }])

    mr.approveError = { status: 401, message: '401 Unauthorized' }
    const before = server.calls.length
    const error: unknown = await forge
      .submitReview('g/a', 1, {
        refs,
        comments: [comments[0] as ReviewComment],
        summary: 'LGTM',
        event: 'approve',
      })
      .then(
        () => undefined,
        (rejection: unknown) => rejection,
      )
    expect(error).toBeInstanceOf(GitLabApiError)
    expect((error as GitLabApiError).message).toContain('failed with 401')
    expect(server.calls).toHaveLength(before + 1)
    expect(mr.drafts).toEqual([])
  })

  test('request_changes without comments still sets the reviewer state', async () => {
    const { server, forge, mr } = setup()
    const version = server.addVersion(mr, DIFFS)
    await forge.submitReview('g/a', 1, {
      refs: {
        baseSha: version.base_commit_sha,
        startSha: version.start_commit_sha,
        headSha: version.head_commit_sha,
      },
      comments: [],
      summary: 'Please split this',
      event: 'request_changes',
    })
    expect(server.calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'POST /draft_notes',
      'POST /draft_notes/bulk_publish',
    ])
    expect(mr.reviewerStates).toEqual(['requested_changes'])
  })
})

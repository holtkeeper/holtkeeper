import { describe, expect, test } from 'bun:test'

import {
  type AiUsageRow,
  type JobRow,
  type KnowledgeRow,
  iso,
  knowledgeContent,
  num,
  toAiUsage,
  toCredential,
  toJob,
  toKnowledgeEntry,
  toKnowledgeRevision,
  toPasskey,
} from './rows.ts'

const at = new Date('2026-10-30T10:00:00.000Z')

describe('row mapping', () => {
  test('iso normalizes dates and strings to the contract form', () => {
    expect(iso(at)).toBe('2026-10-30T10:00:00.000Z')
    expect(iso('2026-10-30 12:00:00+02')).toBe('2026-10-30T10:00:00.000Z')
  })

  test('num turns int8 and numeric strings into numbers', () => {
    expect(num('9007199254740991')).toBe(9007199254740991)
    expect(num('5.5000')).toBe(5.5)
    expect(num(null)).toBe(0)
  })

  test('jobs: nulls become absent fields, timestamps ISO strings', () => {
    const row: JobRow = {
      id: 'j1',
      analyzer: 'bundle',
      repo_forge: 'work',
      repo_path: 'games/a',
      group_name: null,
      ref: 'v1',
      options: { a: 1 },
      trigger: 'manual',
      status: 'running',
      attempts: 1,
      max_attempts: 3,
      run_after: at,
      created_at: at,
      started_at: at,
      finished_at: null,
      worker_id: 'w1',
      heartbeat_at: at,
      error: null,
      analysis_id: null,
      log: ['x'],
      actor: null,
      schedule: null,
    }
    expect(toJob(row)).toEqual({
      id: 'j1',
      analyzer: 'bundle',
      repo: { forge: 'work', path: 'games/a' },
      ref: 'v1',
      options: { a: 1 },
      trigger: 'manual',
      status: 'running',
      attempts: 1,
      maxAttempts: 3,
      runAfter: iso(at),
      createdAt: iso(at),
      startedAt: iso(at),
      workerId: 'w1',
      heartbeatAt: iso(at),
      log: ['x'],
    })
  })

  test('credentials keep options and drop null optionals', () => {
    const credential = toCredential({
      id: 'c',
      name: 'n',
      kind: 'ai',
      url: 'u',
      scope: { all: true },
      secret: 's',
      expires_at: null,
      rotation: null,
      last_rotated_at: null,
      last_error: null,
      options: { headers: { a: 'b' } },
      created_at: at,
      updated_at: at,
    })
    expect(credential).toEqual({
      id: 'c',
      name: 'n',
      kind: 'ai',
      url: 'u',
      scope: { all: true },
      secret: 's',
      options: { headers: { a: 'b' } },
      createdAt: iso(at),
      updatedAt: iso(at),
    })
  })

  test('passkey times are text and stay as given; int8 counters become numbers', () => {
    expect(
      toPasskey({
        id: 'p',
        user_id: 'u',
        public_key: 'k',
        counter: '42',
        transports: null,
        label: null,
        created_at: 'now',
        last_used_at: null,
      }),
    ).toEqual({ id: 'p', userId: 'u', publicKey: 'k', counter: 42, createdAt: 'now' })
  })

  test('knowledge entries and revisions round-trip their content', () => {
    const row: KnowledgeRow = {
      id: 'k',
      title: 't',
      body: 'b',
      kind: 'quirk',
      status: 'accepted',
      source: 'human',
      author: 'jane',
      scope: { groups: ['games'] },
      topics: ['x'],
      applies_to: ['*'],
      packages: null,
      evidence: [],
      supersedes: null,
      created_at: at,
      updated_at: at,
      updated_by: null,
      version: 2,
    }
    const entry = toKnowledgeEntry(row)
    expect(entry.packages).toBeUndefined()
    expect('updatedBy' in entry).toBeFalse()
    const revision = toKnowledgeRevision({
      version: 1,
      content: knowledgeContent(entry),
      edited_by: 'bob',
      edited_at: at,
    })
    expect(revision).toEqual({
      ...knowledgeContent(entry),
      version: 1,
      editedBy: 'bob',
      editedAt: iso(at),
    })
  })

  test('ai usage rows parse bigint strings', () => {
    const row: AiUsageRow = {
      id: 'r',
      at,
      repo_forge: 'work',
      repo_path: 'games/a',
      groups: ['games'],
      task_kind: 'review',
      analyzer: null,
      job_id: 'j',
      analysis_id: null,
      actor: 'jane',
      provider: 'anthropic',
      model: 'm',
      input_tokens: '10',
      output_tokens: '20',
      cache_read_tokens: '0',
      cache_write_tokens: 3,
      cost_usd: 0.5,
      cost_source: 'computed',
      duration_ms: '1500',
      turns: 2,
      outcome: 'ok',
      error: null,
    }
    expect(toAiUsage(row)).toMatchObject({
      at: iso(at),
      jobId: 'j',
      inputTokens: 10,
      outputTokens: 20,
      cacheWriteTokens: 3,
      durationMs: 1500,
    })
    expect('analyzer' in toAiUsage(row)).toBeFalse()
  })
})

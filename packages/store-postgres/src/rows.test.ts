import { describe, expect, test } from 'bun:test'

import {
  type AiUsageRow,
  type AnalysisRow,
  type JobRow,
  type RuleRow,
  iso,
  num,
  toAiUsage,
  toAnalysis,
  toCredential,
  toJob,
  toPasskey,
  toRule,
  toRuleRevision,
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

  test('analyses: metrics come back as stored and are absent when null', () => {
    const row: AnalysisRow = {
      id: 'a1',
      repo_forge: 'work',
      repo_path: 'shapes/a',
      kind: 'coverage',
      ref: null,
      sha: null,
      created_at: at,
      actor: null,
      data: { n: 1 },
      metrics: { percent: 61.5 },
    }
    expect(toAnalysis(row)).toEqual({
      id: 'a1',
      repo: { forge: 'work', path: 'shapes/a' },
      kind: 'coverage',
      createdAt: '2026-10-30T10:00:00.000Z',
      data: { n: 1 },
      metrics: { percent: 61.5 },
    })
    expect(toAnalysis({ ...row, metrics: null })).not.toHaveProperty('metrics')
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
      error_signature: null,
      attempts_history: [{ n: 1, status: 'running', startedAt: '2026-10-30T10:00:00.000Z' }],
      actor: null,
      schedule: null,
      reason: null,
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
      attemptsHistory: [{ n: 1, status: 'running', startedAt: '2026-10-30T10:00:00.000Z' }],
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
      capabilities: null,
      last_used_at: null,
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

  test('rules and revisions round-trip, absent fields stay absent', () => {
    const row: RuleRow = {
      id: 'r',
      title: 't',
      body: 'b',
      description: null,
      scope: { teams: ['games'] },
      files: null,
      agents: null,
      always_apply: null,
      author: 'jane',
      created_at: at,
      updated_at: at,
      updated_by: null,
      version: 2,
    }
    const rule = toRule(row)
    expect(rule).toEqual({
      id: 'r',
      title: 't',
      body: 'b',
      scope: { teams: ['games'] },
      author: 'jane',
      createdAt: iso(at),
      updatedAt: iso(at),
      version: 2,
    })
    expect(
      toRule({ ...row, files: ['src/**'], agents: ['review'], always_apply: false }),
    ).toMatchObject({ files: ['src/**'], agents: ['review'], alwaysApply: false })
    const content = { title: 't', body: 'b', scope: { all: true }, description: 'd' }
    expect(toRuleRevision({ version: 1, content, edited_by: 'bob', edited_at: at })).toEqual({
      ...content,
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
      teams: ['games'],
      task_kind: 'review',
      analyzer: null,
      job_id: 'j',
      analysis_id: null,
      actor: 'jane',
      interactive: true,
      subject: null,
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
      transcript_ref: null,
    }
    expect(toAiUsage(row)).toMatchObject({
      at: iso(at),
      jobId: 'j',
      inputTokens: 10,
      outputTokens: 20,
      cacheWriteTokens: 3,
      durationMs: 1500,
      interactive: true,
    })
    expect('analyzer' in toAiUsage(row)).toBeFalse()
    expect('subject' in toAiUsage(row)).toBeFalse()
    expect(toAiUsage({ ...row, subject: 'MR !7' }).subject).toBe('MR !7')
  })
})

import { describe, expect, test } from 'bun:test'

import {
  createTranscript,
  parseTranscript,
  redactText,
  redactingSink,
  sanitizeEntry,
} from './transcript.ts'

describe('transcripts', () => {
  test('redact given secrets and well-known token shapes', () => {
    expect(redactText('key widget-key-1234 here', ['widget-key-1234'])).toBe('key [redacted] here')
    expect(redactText('use glpat-abcdefghijklmnopqrst now')).toBe('use [redacted] now')
    expect(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe(
      'Authorization: Bearer [redacted]',
    )
    expect(
      redactText('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'),
    ).toBe('[redacted]')
    expect(redactText('short', ['abc'])).toBe('short')
  })

  test('tool results and tool arguments are cut, prompts are kept whole', () => {
    const long = 'x'.repeat(50)
    expect(sanitizeEntry({ type: 'tool-result', id: 't', output: long }, [], 10)).toEqual({
      type: 'tool-result',
      id: 't',
      output: `${'x'.repeat(10)}… [40 more characters]`,
    })
    const call = sanitizeEntry(
      { type: 'assistant', toolCalls: [{ id: 'c', name: 'n', input: { path: long, n: 3 } }] },
      [],
      10,
    )
    expect(call).toEqual({
      type: 'assistant',
      toolCalls: [
        { id: 'c', name: 'n', input: { path: `${'x'.repeat(10)}… [40 more characters]`, n: 3 } },
      ],
    })
    const start = sanitizeEntry(
      { type: 'start', runtime: 'ai-sdk', model: 'm', tier: 'main', tools: [], prompt: long },
      [],
      10,
    )
    expect(start).toMatchObject({ prompt: long })
  })

  test('createTranscript stamps lines and serializes JSONL that parses back', () => {
    let tick = 0
    const transcript = createTranscript({
      secrets: ['sprocket-secret'],
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    })
    const sink = redactingSink(transcript, ['gizmo-header-value'])
    sink.write({ type: 'assistant', text: 'sprocket-secret and gizmo-header-value' })
    sink.write({ type: 'end', outcome: 'ok', turns: 1 })
    const jsonl = transcript.toJsonl()
    expect(jsonl.split('\n').filter(Boolean).length).toBe(2)
    expect(parseTranscript(`${jsonl}not json\n{"no":"type"}\n`)).toEqual([
      { at: '2026-01-01T00:00:00.000Z', type: 'assistant', text: '[redacted] and [redacted]' },
      { at: '2026-01-01T00:00:01.000Z', type: 'end', outcome: 'ok', turns: 1 },
    ])
  })
})

import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { AgentOutputError, answerInToolCall, parseAgentOutput } from './output.ts'

const schema = z.object({ path: z.string(), count: z.number() })

describe('parseAgentOutput', () => {
  test('parses bare JSON', () => {
    expect(parseAgentOutput('{"path":"a.ts","count":1}', schema)).toEqual({
      path: 'a.ts',
      count: 1,
    })
  })

  test('strips a code fence', () => {
    expect(parseAgentOutput('```json\n{"path":"a.ts","count":2}\n```', schema)).toEqual({
      path: 'a.ts',
      count: 2,
    })
  })

  test('finds JSON surrounded by prose', () => {
    const text = 'Here it is:\n```json\n{"path":"b.ts","count":3}\n```\nDone.'
    expect(parseAgentOutput(text, schema)).toEqual({ path: 'b.ts', count: 3 })
    expect(parseAgentOutput('Result: {"path":"c.ts","count":4} ok', schema)).toEqual({
      path: 'c.ts',
      count: 4,
    })
  })

  test('fails clearly on non-JSON', () => {
    expect(() => parseAgentOutput('I could not do it', schema)).toThrow(AgentOutputError)
    expect(() => parseAgentOutput('I could not do it', schema)).toThrow('not valid JSON')
  })

  test('fails clearly on a shape mismatch', () => {
    expect(() => parseAgentOutput('{"path":1}', schema)).toThrow(/path: .*count: /)
  })
})

describe('answerInToolCall', () => {
  const verdictSchema = z.object({ verdict: z.enum(['ok', 'bad']), notes: z.array(z.string()) })

  test('takes an answer passed as the arguments, a field or JSON text', () => {
    const answer = { verdict: 'ok', notes: [] }
    expect(answerInToolCall('json', JSON.stringify(answer), verdictSchema)).toEqual({ answer })
    expect(answerInToolCall('json', JSON.stringify({ value: answer }), verdictSchema)).toEqual({
      answer,
    })
    expect(
      answerInToolCall('json', JSON.stringify({ json: JSON.stringify(answer) }), verdictSchema),
    ).toEqual({ answer })
  })

  test('names the mismatches of something that looks like an answer', () => {
    const found = answerInToolCall('final_answer', '{"verdict":"maybe","notes":[]}', verdictSchema)
    const problem = found && 'problem' in found ? found.problem : ''
    expect(problem).toContain('final_answer is not a tool')
    expect(problem).toContain('verdict')
  })

  test('leaves calls without anything like an answer alone', () => {
    expect(answerInToolCall('lookup', '{}', verdictSchema)).toBeUndefined()
    expect(answerInToolCall('lookup', 'not json', verdictSchema)).toBeUndefined()
    expect(answerInToolCall('lookup', '{"path":"src/a.ts"}', verdictSchema)).toBeUndefined()
  })
})

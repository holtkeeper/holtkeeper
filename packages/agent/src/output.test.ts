import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { AgentOutputError, parseAgentOutput } from './output.ts'

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

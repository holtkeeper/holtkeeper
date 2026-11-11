import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { RESULT_CAPS, capText, capTool, capToolsets, mountToolsets } from './registry.ts'
import { defineTool } from './tool.ts'

const ctx = { dir: '/r', signal: new AbortController().signal }

const echo = defineTool({
  name: 'widget_hits',
  description: 'Returns the limit it was called with',
  input: z.object({ query: z.string(), limit: z.number().int().optional() }),
  defaultLimit: 30,
  run: ({ limit }) => `limit=${limit ?? 'unset'}`,
})

describe('result caps', () => {
  test('capText keeps short text and cuts long text at a line break with a marker', () => {
    expect(capText('short', 100)).toBe('short')
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const cut = capText(text, 100, 'pass a smaller range')
    expect(cut.length).toBeLessThan(160)
    expect(cut).toStartWith('line 0\nline 1')
    expect(cut).not.toContain('line 49')
    expect(cut).toEndWith('… output cut at about 25 tokens; pass a smaller range.')
    expect(cut.split('\n\n')[0]?.endsWith('\n')).toBe(false)
  })

  test('capTool clamps limit to maxSnippets, using the default limit when none is passed', async () => {
    const capped = capTool(echo, { maxChars: 1000, maxSnippets: 20 })
    expect(await capped.run({ query: 'a' }, ctx)).toBe('limit=20')
    expect(await capped.run({ query: 'a', limit: 5 }, ctx)).toBe('limit=5')
    expect(await capped.run({ query: 'a', limit: 100 }, ctx)).toBe('limit=20')
    const small = capTool({ ...echo, defaultLimit: 5 }, { maxChars: 1000, maxSnippets: 20 })
    expect(await small.run({ query: 'a' }, ctx)).toBe('limit=5')
  })

  test('capTool leaves tools without limit alone and caps their text', async () => {
    const long = defineTool({
      name: 'gadget_dump',
      description: 'A long answer',
      input: z.object({ part: z.string().optional() }),
      run: (input) => `${JSON.stringify(input)}\n${'x'.repeat(RESULT_CAPS.maxChars * 2)}`,
    })
    const result = await capTool(long).run({}, ctx)
    expect(result).toStartWith('{}\n')
    expect(result.length).toBeLessThan(RESULT_CAPS.maxChars + 100)
    expect(result).toContain('output cut at about 4000 tokens')
  })

  test('capToolsets caps every tool and keeps names and schemas', () => {
    const [capped] = capToolsets([{ name: 'widgets', tools: [echo] }])
    expect(capped?.name).toBe('widgets')
    expect(capped?.tools[0]?.name).toBe('widget_hits')
    expect(capped?.tools[0]?.input).toBe(echo.input)
    expect(capped?.tools[0]).not.toBe(echo)
  })
})

describe('mountToolsets', () => {
  test('mounts the named toolsets in the order asked and skips unknown names', () => {
    const toolsets = [
      { name: 'alpha', tools: [] },
      { name: 'beta', tools: [] },
      { name: 'gamma', tools: [] },
    ]
    expect(
      mountToolsets(toolsets, ['gamma', 'missing', 'alpha']).map((toolset) => toolset.name),
    ).toEqual(['gamma', 'alpha'])
    expect(mountToolsets(toolsets, [])).toEqual([])
  })
})

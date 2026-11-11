import type { Toolset } from '@holtkeeper/agent'

import type { RegistryTool } from './tool.ts'

/** How much one tool call may return. */
export interface ResultCaps {
  /** Longest result in characters; longer ones are cut at a line break with a marker. */
  maxChars: number
  /** Most hits a tool with a `limit` argument returns per call. */
  maxSnippets: number
}

/** Caps of internal agent tool calls: about 4k tokens and 20 snippets per call. */
export const RESULT_CAPS: Readonly<ResultCaps> = { maxChars: 16_000, maxSnippets: 20 }

/**
 * `text` when it fits in `maxChars`; otherwise its head cut at the last line break that fits,
 * followed by a marker saying output was cut and `hint` on how to narrow the request.
 */
export function capText(text: string, maxChars: number, hint = 'narrow the request'): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const lineEnd = head.lastIndexOf('\n')
  const kept = lineEnd > maxChars / 2 ? head.slice(0, lineEnd) : head
  return `${kept}\n\n… output cut at about ${Math.round(maxChars / 4)} tokens; ${hint}.`
}

/**
 * `tool` with its results capped: a `limit` argument (passed or the tool's `defaultLimit`) is
 * clamped to `caps.maxSnippets`, and the text to `caps.maxChars`.
 */
export function capTool(tool: RegistryTool, caps: ResultCaps = RESULT_CAPS): RegistryTool {
  const limited = 'limit' in tool.input.shape
  return {
    ...tool,
    async run(input, ctx) {
      const args = limited
        ? {
            ...input,
            limit: Math.min(
              typeof input['limit'] === 'number'
                ? input['limit']
                : (tool.defaultLimit ?? caps.maxSnippets),
              caps.maxSnippets,
            ),
          }
        : input
      return capText(await tool.run(args, ctx), caps.maxChars)
    },
  }
}

/** `toolsets` with every tool capped by `capTool`. */
export function capToolsets(
  toolsets: readonly Toolset[],
  caps: ResultCaps = RESULT_CAPS,
): Toolset[] {
  return toolsets.map((toolset) => ({
    ...toolset,
    tools: toolset.tools.map((tool) => capTool(tool, caps)),
  }))
}

/**
 * The toolsets of `available` named in `names`, in the order of `names`. Names without a toolset
 * are skipped, so a task may ask for a toolset the deployment does not offer.
 */
export function mountToolsets<T extends Toolset>(
  available: readonly T[],
  names: readonly string[],
): T[] {
  return names.flatMap((name) => available.filter((toolset) => toolset.name === name))
}

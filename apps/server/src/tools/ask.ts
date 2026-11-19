import type { ToolContext } from '@holtkeeper/agent'
import { type RegistryToolset, defineTool } from '@holtkeeper/agent-tools'
import { z } from 'zod'

/** A question as `ask` takes it. */
export interface AskInput {
  question: string
  /** The repository the question is about, as `forge:path`. */
  repo?: string
  /** Repository-relative paths the question is about. */
  files?: string[]
}

/** Answers questions for one caller. */
export interface AskAccess {
  /**
   * The answer to `input.question` as Markdown whose statements name sources the answering run
   * read, followed by the list of those sources; or a short explanation when no grounded answer
   * was found. Throws a `ToolError` when it cannot answer at all (quota, budget, no provider, a
   * repository the caller may not read).
   */
  ask(input: AskInput, ctx: Pick<ToolContext, 'signal' | 'progress'>): Promise<string>
}

/** Name of the tool of the `ask` toolset. */
export const ASK_TOOL = 'ask'

/**
 * The `ask` toolset of the MCP endpoint: one tool that hands a question to an agent working
 * read-only over the other toolsets with the caller's reach.
 */
export function askToolset(access: AskAccess): RegistryToolset {
  return {
    name: 'ask',
    instructions:
      'ask answers a question that would take several of these tools, with sources; it takes up to a minute and spends the AI budget, so use the direct tools for single lookups.',
    tools: [
      defineTool({
        name: ASK_TOOL,
        description:
          'Answers a question about the organization’s packages, third-party libraries, repositories, stacks, rules and conventions. An agent reads them with your reach and answers in Markdown; every statement ends with its source ([rule:<id>], [learn:<id>], [pkg:<name>@<version> <export>], [file:<repo> <path>:<line>], [doc:<name>@<version> <path>], [url:<link>]) and the sources are listed at the end. A source nothing it read backs is replaced by [unverified]; with no backed source at all it says so instead of answering. Ask one specific question and pass `repo`. It cannot read a repository’s working tree, only what Holtkeeper indexed. Takes up to a minute; limited per person per day.',
        input: z.object({
          question: z
            .string()
            .min(8)
            .max(2000)
            .describe('One specific question, with the names and versions involved'),
          repo: z
            .string()
            .min(1)
            .optional()
            .describe('The repository you work in, as forge:path: its rules and versions apply'),
          files: z
            .array(z.string().min(1))
            .max(50)
            .optional()
            .describe('Repository-relative paths the question is about'),
        }),
        run: ({ question, repo, files }, ctx) =>
          access.ask(
            { question, ...(repo && { repo }), ...(files?.length && { files }) },
            { signal: ctx.signal, ...(ctx.progress && { progress: ctx.progress }) },
          ),
        subject: ({ repo, question }) => repo ?? question.slice(0, 80),
      }),
    ],
  }
}

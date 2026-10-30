import type { CodeChange, Edit } from '@holtkeeper/changes'
import { z } from 'zod'

import { errorMessage } from '../sources/types.ts'
import { renderJson, renderTemplate, templateSchema } from './template.ts'
import type { OutputProvider, OutputResult } from './types.ts'

const schema = z.object({
  kind: z.literal('repo-file'),
  id: z.string().min(1).optional(),
  /** Repository path (an optional `forge:` prefix is ignored). */
  repo: z.string().min(1),
  /** File path in the repository. */
  path: z.string().min(1),
  /** Default from the extension: `.json` → json, else markdown. */
  format: z.enum(['markdown', 'json']).optional(),
  /** Branch the current content is read from; the default branch when omitted. */
  ref: z.string().min(1).optional(),
  /** Change title; default `docs: update <path>`. */
  title: z.string().min(1).optional(),
  template: templateSchema.default({ findings: false }),
})

/** A `repo-file` output as configured. */
export type RepoFileConfig = z.output<typeof schema>

/** Position just past the end of `text`. */
function endOf(text: string) {
  const lines = text.split('\n')
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

/** Edits turning `before` (absent: no file) into `after`; none when they are equal. */
export function fileEdits(file: string, before: string | undefined, after: string): Edit[] {
  if (before === undefined) return [{ kind: 'create', file, newText: after }]
  if (before === after) return []
  return [
    {
      kind: 'replace',
      file,
      range: { start: { line: 1, column: 1 }, end: endOf(before) },
      oldText: before,
      newText: after,
    },
  ]
}

/** Renders Markdown or JSON into a repository file, as a `CodeChange` targeting that repository. */
export const repoFileOutput = {
  kind: 'repo-file',
  schema,
  async plan(config, context): Promise<OutputResult> {
    const result: OutputResult = { publications: [], changes: [], errors: [] }
    const repo =
      config.repo.includes(':') && !config.repo.split(':')[0]!.includes('/')
        ? config.repo.slice(config.repo.indexOf(':') + 1)
        : config.repo
    const format = config.format ?? (config.path.endsWith('.json') ? 'json' : 'markdown')
    const content =
      format === 'json'
        ? renderJson(context.entities, context.findings, config.template, context.tracker.id)
        : renderTemplate(context.entities, context.findings, config.template, 'markdown')
    if (!context.forge) {
      result.errors.push({
        output: context.id,
        repo,
        file: config.path,
        message: 'repo-file outputs need a forge',
      })
      return result
    }
    let before: string | undefined
    try {
      before = await context.forge.readFile(repo, config.path, config.ref)
    } catch (error) {
      result.errors.push({
        output: context.id,
        repo,
        file: config.path,
        message: errorMessage(error),
      })
      return result
    }
    const edits = fileEdits(config.path, before, content)
    if (!edits.length) return result
    const change: CodeChange = {
      id: `tracker:${context.tracker.id}:${context.id}:${repo}:${config.path}`,
      title: config.title ?? `docs: update ${config.path}`,
      description: `${before === undefined ? 'Creates' : 'Updates'} ${config.path} from tracker ${context.tracker.name}.`,
      confidence: 'safe',
      source: 'tracker',
      ...(context.forgeId ? { target: { forge: context.forgeId, path: repo } } : {}),
      edits,
    }
    result.changes.push(change)
    return result
  },
} satisfies OutputProvider<RepoFileConfig>

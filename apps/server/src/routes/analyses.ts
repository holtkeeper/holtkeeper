import type {
  AnalysisDetail,
  AnalysisKindList,
  AnalysisList,
  AnalysisSummary,
  ApplyChangesResult,
} from '@holtkeeper/api'
import { artifactId } from '@holtkeeper/artifacts'
import { openMergeRequest, planChanges, unifiedDiff } from '@holtkeeper/changes'
import type { GitForge } from '@holtkeeper/forge'
import type { AnalysisKind } from '@holtkeeper/report'
import type { AnalysisRecord } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { summarizeAnalysis } from '../analyses.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  limitParam,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { noteLibraryUses } from '../libraries.ts'
import { canSee } from '../visibility.ts'
import { peopleOf } from './avatars.ts'

const applySchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  mode: z.enum(['patch', 'merge-request']),
  title: z.string().min(1).optional(),
})

const ingestSchema = z.object({
  repo: z.object({ forge: z.string().min(1), path: z.string().min(1) }),
  kind: z.string().min(1),
  ref: z.string().min(1).optional(),
  createdAt: z.iso.datetime().optional(),
  data: z.unknown(),
  artifacts: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256'),
        base64: z.base64(),
        contentType: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      }),
    )
    .max(500)
    .optional(),
})

/**
 * Results of every analysis kind (changelog, bundle sizes, dependency graph, ...), rendered into
 * universal reports. Routes know only the `AnalysisKind` contract; kinds come from `ServerDeps`.
 */
export function analysisRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const resolveArtifact = async (id: string) => (await deps.artifacts?.get(id))?.data
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))
  const app = new Hono<Env>()

  const kindOf = (name: string): AnalysisKind => {
    const kind = kinds.get(name)
    if (!kind) throw new HTTPException(400, { message: `unknown analysis kind ${name}` })
    return kind
  }

  const summarize = (record: AnalysisRecord) => summarizeAnalysis(kinds, record)

  const readable = async (c: AppContext, id: string) => {
    const record = await store.analyses.get(id)
    if (!record) throw new HTTPException(404, { message: 'analysis not found' })
    authorize(c, 'analyses:read', { kind: 'repo', repo: repoTarget(config, record.repo) })
    return record
  }

  app.get('/analyses/kinds', (c) =>
    c.json<AnalysisKindList>({ kinds: deps.analyses.map(({ kind, label }) => ({ kind, label })) }),
  )

  app.get('/analyses', async (c) => {
    const principal = principalOf(c)
    const repo = parseRepo(c.req.query('repo'))
    const kind = c.req.query('kind')
    const before = c.req.query('before')
    const records = await store.analyses.list({
      ...(repo ? { repo } : {}),
      ...(kind ? { kind } : {}),
      ...(before ? { before } : {}),
      limit: limitParam(c.req.query('limit')),
    })
    const visible = records.filter((r) =>
      canSee(principal, 'analyses:read', repoTarget(config, r.repo)),
    )
    return c.json<AnalysisList>({
      analyses: visible.map(summarize),
      people: await peopleOf(
        deps,
        visible.flatMap((r) => (r.actor ? [r.actor] : [])),
      ),
    })
  })

  app.get('/analyses/:id', async (c) => {
    const record = await readable(c, c.req.param('id'))
    const kind = kindOf(record.kind)
    const compare = c.req.query('compare')
    const previous = compare
      ? await readable(c, compare)
      : (
          await store.analyses.list({
            repo: record.repo,
            kind: record.kind,
            before: record.createdAt,
            limit: 1,
          })
        )[0]
    if (previous && previous.kind !== record.kind) {
      throw new HTTPException(400, { message: 'can only compare analyses of the same kind' })
    }
    return c.json<AnalysisDetail>({
      analysis: summarize(record),
      ...(previous ? { previous: summarize(previous) } : {}),
      report: kind.toReport(record, previous),
    })
  })

  /** The forge client for a repository's forge, or 409 when the config cannot reach it. */
  const forgeFor = (forgeId: string): GitForge => {
    const definition = config.forges[forgeId]
    if (!definition) throw new HTTPException(409, { message: `forge ${forgeId} is not configured` })
    try {
      return definition.create()
    } catch (error) {
      throw new HTTPException(409, {
        message: `forge ${forgeId} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  app.post('/analyses/:id/changes', async (c) => {
    const record = await readable(c, c.req.param('id'))
    const input = await readBody(c, applySchema)
    const principal = authorize(c, 'analyses:run', {
      kind: 'repo',
      repo: repoTarget(config, record.repo),
    })
    const available = kindOf(record.kind).changes?.(record.data) ?? []
    const selected = available.filter((change) => input.ids.includes(change.id))
    const missing = input.ids.filter((id) => !selected.some((change) => change.id === id))
    if (missing.length)
      throw new HTTPException(400, { message: `unknown changes: ${missing.join(', ')}` })

    const title =
      input.title ??
      (selected.length === 1
        ? (selected[0]?.title ?? 'Holtkeeper changes')
        : `Holtkeeper: ${selected.length} suggested changes`)
    const byTarget = Map.groupBy(selected, (change) => {
      const target = change.target ?? record.repo
      return `${target.forge}:${target.path}`
    })
    for (const key of byTarget.keys()) {
      const separator = key.indexOf(':')
      authorize(c, 'analyses:run', {
        kind: 'repo',
        repo: repoTarget(config, {
          forge: key.slice(0, separator),
          path: key.slice(separator + 1),
        }),
      })
    }

    const result: ApplyChangesResult = { applied: [], conflicts: [] }
    const patches: string[] = []
    const mergeRequests: { id: number; url: string }[] = []

    for (const [key, changes] of byTarget) {
      const separator = key.indexOf(':')
      const forgeId = key.slice(0, separator)
      const repo = key.slice(separator + 1)
      const forge = forgeFor(forgeId)

      if (input.mode === 'patch') {
        const base = (await forge.getRepository(repo)).defaultBranch
        const before = new Map<string, string | undefined>()
        const plan = await planChanges(
          changes,
          {
            read: async (file) => {
              const content = await forge.readFile(repo, file, base)
              before.set(file, content)
              return content
            },
            ...(forge.readFileBytes
              ? {
                  readBytes: async (file: string) => {
                    const bytes = await forge.readFileBytes?.(repo, file, base)
                    before.set(file, bytes && '')
                    return bytes
                  },
                }
              : {}),
          },
          { resolveArtifact },
        )
        result.applied.push(...plan.applied)
        result.conflicts.push(...plan.conflicts)
        if (plan.files.length) {
          const header = byTarget.size > 1 ? `# ${key}\n` : ''
          patches.push(
            header +
              unifiedDiff(
                plan.files.map(({ file, content, bytes }) => ({
                  file,
                  before: before.get(file),
                  after: content,
                  ...(bytes ? { bytes } : {}),
                })),
              ),
          )
        }
        continue
      }

      const outcome = await openMergeRequest({ forge, repo, changes, title, resolveArtifact })
      result.applied.push(...outcome.plan.applied)
      result.conflicts.push(...outcome.plan.conflicts)
      if (outcome.mergeRequest) {
        mergeRequests.push({ id: outcome.mergeRequest.id, url: outcome.mergeRequest.webUrl })
        await store.activity.append({
          at: deps.now().toISOString(),
          actor: principal.id,
          action: 'changes.merge_request_opened',
          subject: key,
          details: {
            analysis: record.id,
            changes: outcome.plan.applied,
            mergeRequest: outcome.mergeRequest.webUrl,
          },
        })
      }
    }

    if (input.mode === 'patch') result.patch = patches.join('\n')
    if (mergeRequests[0]) result.mergeRequest = mergeRequests[0]
    if (mergeRequests.length > 1) result.mergeRequests = mergeRequests
    return c.json<ApplyChangesResult>(result)
  })

  app.post('/analyses', async (c) => {
    const input = await readBody(c, ingestSchema)
    const kind = kindOf(input.kind)
    const principal = authorize(c, 'analyses:run', {
      kind: 'repo',
      repo: repoTarget(config, input.repo),
    })
    const parsed = kind.schema.safeParse(input.data)
    if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) })
    const artifacts = input.artifacts ?? []
    if (artifacts.length && !deps.artifacts)
      throw new HTTPException(503, { message: 'no artifact store is configured' })
    const decoded = artifacts.map((artifact) => ({
      ...artifact,
      data: new Uint8Array(Buffer.from(artifact.base64, 'base64')),
    }))
    const wrong = decoded.find((artifact) => artifactId(artifact.data) !== artifact.id)
    if (wrong)
      throw new HTTPException(400, { message: `artifact ${wrong.id} does not match its content` })

    const record = await store.analyses.add({
      repo: input.repo,
      kind: input.kind,
      ...(input.ref ? { ref: input.ref } : {}),
      createdAt: input.createdAt ?? deps.now().toISOString(),
      actor: principal.id,
      data: parsed.data,
    })
    await noteLibraryUses(store.kv, record.kind, deps.now())
    for (const artifact of decoded) {
      await deps.artifacts?.put(artifact.data, {
        ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
        ...(artifact.name ? { name: artifact.name } : {}),
        tags: {
          repo: `${record.repo.forge}:${record.repo.path}`,
          kind: record.kind,
          analysis: record.id,
        },
      })
    }
    await store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'analysis.ingested',
      subject: `${record.repo.forge}:${record.repo.path}`,
      details: { id: record.id, kind: record.kind, ...(record.ref ? { ref: record.ref } : {}) },
    })
    return c.json<AnalysisSummary>(summarize(record), 201)
  })

  return app
}

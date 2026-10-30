import type {
  MediaApplyInput,
  MediaApplyResult,
  MediaVariantView,
  MediaVariantsInput,
  MediaVariantsResult,
} from '@holtkeeper/api'
import {
  artifactCache,
  artifactId,
  isArtifactId,
  safeArchivePath,
  zipArtifacts,
} from '@holtkeeper/artifacts'
import { type CodeChange, type Edit, openMergeRequest } from '@holtkeeper/changes'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  artifactsOf,
  authorize,
  forgeFor,
  parseRepo,
  readBody,
  repoTarget,
} from '../context.ts'
import { imageContentType, mediaEngine } from '../media/adapter.ts'
import type { MediaEngine } from '../media/engine.ts'
import { createLimiter, savingsPercent, summarizeSavings, variantPath } from '../media/savings.ts'
import { downloadHeaders, messageOf } from './artifacts.ts'

const repoPattern = /^[^:]+:.+$/
const filePath = z.string().min(1).max(500)
const artifactRef = z.string().regex(/^[0-9a-f]{64}$/, 'expected an artifact id')
const position = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})

const variantsSchema = z.object({
  repo: z.string().regex(repoPattern, 'repo must look like <forge>:<path>'),
  file: filePath,
  ref: z.string().min(1).optional(),
  formats: z
    .array(z.string().regex(/^[a-z0-9]+$/))
    .max(6)
    .optional(),
  widths: z.array(z.number().int().positive().max(8192)).max(12).optional(),
  densities: z.array(z.number().positive().max(4)).max(4).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  preset: z.string().min(1).max(50).optional(),
}) satisfies z.ZodType<MediaVariantsInput>

const applySchema = z.object({
  repo: z.string().regex(repoPattern, 'repo must look like <forge>:<path>'),
  file: filePath,
  ref: z.string().min(1).optional(),
  variants: z.array(artifactRef).max(50),
  paths: z.record(artifactRef, filePath).optional(),
  replaceOriginal: artifactRef.optional(),
  snippet: z
    .object({
      file: filePath,
      range: z.object({ start: position, end: position }),
      oldText: z.string(),
      newText: z.string(),
    })
    .optional(),
  mode: z.enum(['merge-request', 'zip']),
  title: z.string().min(1).max(200).optional(),
}) satisfies z.ZodType<MediaApplyInput>

/** Limits of the media routes; `createApp` uses the defaults. */
export interface MediaLimits {
  /** Largest original read from the forge. Default 25 MB. */
  maxBytes: number
  /** Largest decoded image (width × height). Default 50 megapixels. */
  maxPixels: number
  /** Images processed at once. Default 2. */
  concurrency: number
  /** Requests waiting for a slot before new ones get 429. Default 8. */
  maxQueued: number
  /** Results kept for repeated requests. Default 100. */
  cacheEntries: number
}

const defaultLimits: MediaLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxPixels: 50_000_000,
  concurrency: 2,
  maxQueued: 8,
  cacheEntries: 100,
}

const isSvg = (file: string) => /\.svg$/i.test(file)
const repoKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/**
 * Responsive image variants and SVG optimization for files in repositories. Results are stored as
 * artifacts; `apply` turns chosen ones into a merge request or a ZIP download.
 */
export function mediaRoutes(deps: ServerDeps, limits: Partial<MediaLimits> = {}) {
  const { config } = deps
  const limit = { ...defaultLimits, ...limits }
  const app = new Hono<Env>()
  const run = createLimiter(limit.concurrency, limit.maxQueued)
  const cache = new Map<string, MediaVariantsResult>()
  let engine: MediaEngine | undefined
  const engineOf = () =>
    (engine ??=
      deps.media ?? mediaEngine(deps.artifacts ? { cache: artifactCache(deps.artifacts) } : {}))

  const repoOf = (c: AppContext, value: string, action: 'analyses:read' | 'analyses:run') => {
    const repo = parseRepo(value)
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    const principal = authorize(c, action, { kind: 'repo', repo: repoTarget(config, repo) })
    return { repo, principal }
  }

  const readOriginal = async (forge: GitForge, repo: string, file: string, ref?: string) => {
    let data: Uint8Array | undefined
    if (isSvg(file)) {
      const text = await forge.readFile(repo, file, ref)
      data = text === undefined ? undefined : new TextEncoder().encode(text)
    } else {
      if (!forge.readFileBytes)
        throw new HTTPException(409, { message: `forge ${forge.kind} cannot read binary files` })
      data = await forge.readFileBytes(repo, file, ref)
    }
    if (!data) throw new HTTPException(404, { message: `${file} not found` })
    if (data.byteLength > limit.maxBytes)
      throw new HTTPException(413, { message: `${file} is larger than ${limit.maxBytes} bytes` })
    return data
  }

  const remember = (key: string, result: MediaVariantsResult) => {
    cache.delete(key)
    cache.set(key, result)
    while (cache.size > limit.cacheEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const stillStored = async (result: MediaVariantsResult) => {
    const store = artifactsOf(deps)
    const ids = [...result.variants.map((v) => v.id), ...(result.svg ? [result.svg.id] : [])]
    for (const id of ids) if (!(await store.has(id))) return false
    return true
  }

  app.post('/media/variants', async (c) => {
    const input = await readBody(c, variantsSchema)
    const { repo } = repoOf(c, input.repo, 'analyses:read')
    const store = artifactsOf(deps)
    const forge = forgeFor(config, repo.forge)
    const data = await readOriginal(forge, repo.path, input.file, input.ref)
    const sha256 = artifactId(data)
    const { repo: _repo, ref: _ref, ...options } = input
    const key = JSON.stringify([sha256, options])
    const cached = cache.get(key)
    if (cached && (await stillStored(cached))) {
      remember(key, cached)
      return c.json<MediaVariantsResult>(cached)
    }

    const tags = { repo: repoKey(repo), kind: 'media', source: input.file }
    const outcome = await run(async (): Promise<MediaVariantsResult> => {
      const media = engineOf()
      if (isSvg(input.file)) {
        const svg = await media.optimizeSvg({
          svg: new TextDecoder().decode(data),
          file: input.file,
        })
        const stored = await store.put(new TextEncoder().encode(svg.data), {
          contentType: 'image/svg+xml',
          name: input.file,
          tags,
        })
        const original = {
          bytes: data.byteLength,
          width: svg.width ?? 0,
          height: svg.height ?? 0,
          format: 'svg',
        }
        return {
          original: { ...original, sha256 },
          variants: [],
          svg: { id: stored.id, before: svg.before, after: svg.after, breakdown: svg.breakdown },
          snippets: await media.snippets({ file: input.file, original, variants: [] }),
          savings: summarizeSavings(data.byteLength, [
            { format: 'svg', width: original.width, bytes: stored.bytes },
          ]),
        }
      }

      let encoded: Awaited<ReturnType<MediaEngine['variants']>>
      try {
        encoded = await media.variants({
          data,
          file: input.file,
          options,
          maxPixels: limit.maxPixels,
        })
      } catch (error) {
        throw new HTTPException(422, {
          message: `cannot process ${input.file}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      const { original } = encoded
      if (original.width * original.height > limit.maxPixels)
        throw new HTTPException(413, {
          message: `${input.file} has more than ${limit.maxPixels} pixels`,
        })

      const variants: MediaVariantView[] = []
      for (const variant of encoded.variants) {
        const suggested = variant.path ?? variantPath(input.file, variant.format, variant.width)
        const stored = await store.put(variant.data, {
          contentType: variant.contentType || imageContentType(variant.format),
          name: suggested,
          tags,
        })
        variants.push({
          id: stored.id,
          format: variant.format,
          width: variant.width,
          height: variant.height,
          quality: variant.quality,
          bytes: stored.bytes,
          savingsPercent: savingsPercent(data.byteLength, stored.bytes),
          path: suggested,
        })
      }
      return {
        original: { ...original, bytes: data.byteLength, sha256 },
        variants,
        snippets: await media.snippets({
          file: input.file,
          original,
          variants: variants.map(({ path, format, width, height }) => ({
            path,
            format,
            width,
            height,
          })),
        }),
        savings: summarizeSavings(data.byteLength, variants),
      }
    })
    if (outcome === 'busy')
      throw new HTTPException(429, { message: 'the image engine is busy, try again shortly' })
    remember(key, outcome)
    return c.json<MediaVariantsResult>(outcome)
  })

  app.post('/media/apply', async (c) => {
    const input = await readBody(c, applySchema)
    const { repo, principal } = repoOf(c, input.repo, 'analyses:run')
    const store = artifactsOf(deps)
    const ids = [
      ...new Set([...input.variants, ...(input.replaceOriginal ? [input.replaceOriginal] : [])]),
    ]
    if (!ids.length && !input.snippet) throw new HTTPException(400, { message: 'nothing to apply' })

    const infos = new Map<string, { bytes: number; name?: string }>()
    for (const id of ids) {
      const info = isArtifactId(id) ? await store.stat(id) : undefined
      if (!info) throw new HTTPException(404, { message: `artifact ${id} not found` })
      infos.set(id, info)
    }
    const pathOf = (id: string) => {
      const target = input.paths?.[id] ?? infos.get(id)?.name
      if (!target) throw new HTTPException(400, { message: `no path for artifact ${id}` })
      try {
        return safeArchivePath(target)
      } catch (error) {
        throw new HTTPException(400, { message: messageOf(error) })
      }
    }

    if (input.mode === 'zip') {
      const entries: { path: string; data: Uint8Array | string }[] = []
      for (const id of ids) {
        const artifact = await store.get(id)
        if (!artifact) throw new HTTPException(404, { message: `artifact ${id} not found` })
        entries.push({
          path: id === input.replaceOriginal ? input.file : pathOf(id),
          data: artifact.data,
        })
      }
      entries.push({
        path: 'README.md',
        data: readme(
          input,
          entries.map((e) => e.path),
        ),
      })
      let zip: Uint8Array
      try {
        zip = zipArtifacts(entries)
      } catch (error) {
        throw new HTTPException(400, { message: messageOf(error) })
      }
      const stem =
        input.file
          .split('/')
          .at(-1)
          ?.replace(/\.[^.]+$/, '') || 'media'
      return new Response(zip, { headers: downloadHeaders('application/zip', `${stem}-media.zip`) })
    }

    const forge = forgeFor(config, repo.forge)
    const edits: Edit[] = []
    if (input.replaceOriginal) {
      const original = await readOriginal(forge, repo.path, input.file, input.ref)
      edits.push({
        kind: 'write-binary',
        file: input.file,
        bytes: infos.get(input.replaceOriginal)?.bytes ?? 0,
        artifact: input.replaceOriginal,
        previousSha256: artifactId(original),
      })
    }
    for (const id of input.variants) {
      if (id === input.replaceOriginal) continue
      edits.push({
        kind: 'write-binary',
        file: pathOf(id),
        bytes: infos.get(id)?.bytes ?? 0,
        artifact: id,
      })
    }
    if (input.snippet) edits.push({ kind: 'replace', ...input.snippet })

    const title = input.title ?? `Optimize ${input.file}`
    const change: CodeChange = {
      id: `media:${artifactId(new TextEncoder().encode(JSON.stringify(edits))).slice(0, 12)}`,
      title,
      confidence: 'review',
      source: 'media',
      edits,
    }
    const outcome = await openMergeRequest({
      forge,
      repo: repo.path,
      changes: [change],
      title,
      ...(input.ref ? { base: input.ref } : {}),
      resolveArtifact: async (id) => (await store.get(id))?.data,
    })
    const result: MediaApplyResult = {
      applied: outcome.plan.applied.length > 0,
      conflicts: outcome.plan.conflicts,
    }
    if (outcome.mergeRequest) {
      result.mergeRequest = { id: outcome.mergeRequest.id, url: outcome.mergeRequest.webUrl }
      await deps.store.activity.append({
        at: deps.now().toISOString(),
        actor: principal.id,
        action: 'media.merge_request_opened',
        subject: repoKey(repo),
        details: {
          file: input.file,
          files: edits.map((e) => e.file),
          mergeRequest: outcome.mergeRequest.webUrl,
        },
      })
    }
    return c.json<MediaApplyResult>(result)
  })

  return app
}

function readme(input: MediaApplyInput, files: string[]): string {
  const lines = [
    `# Optimized images for ${input.file}`,
    '',
    'Copy these files into the repository at the same paths:',
    '',
    ...files.map((file) => `- \`${file}\``),
  ]
  if (input.snippet) {
    const fence = input.snippet.newText.includes('```') ? '~~~~' : '```'
    lines.push(
      '',
      `Then replace the markup in \`${input.snippet.file}\` (line ${input.snippet.range.start.line}) with:`,
      '',
      fence,
      input.snippet.newText,
      fence,
    )
  }
  return `${lines.join('\n')}\n`
}

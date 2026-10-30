import { S3Client } from 'bun'

import {
  type StoreOptions,
  createArtifactStore,
  fanout,
  isArtifactId,
  isArtifactInfo,
} from './core.ts'
import type { ArtifactInfo, ArtifactStore } from './types.ts'

export interface S3ArtifactStoreOptions extends StoreOptions {
  bucket: string
  /** e.g. `https://s3.eu-central-1.amazonaws.com`, a MinIO, R2 or Garage URL. Default: AWS for `region`. */
  endpoint?: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Key prefix, e.g. `holtkeeper/artifacts`; keys are `<prefix>/ab/cd/<id>`. Default none. */
  prefix?: string
  /** `https://<bucket>.<endpoint>` addressing instead of path style. */
  virtualHostedStyle?: boolean
  /** Parallel sidecar reads while listing. Default 16. */
  listConcurrency?: number
}

const missing = (error: unknown) => {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  return (
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    (typeof message === 'string' && /\b404\b|not ?found|no ?such ?key/i.test(message))
  )
}

const orMissing = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read()
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

const quoteFilename = (name: string) => name.replace(/["\\\r\n]/g, '_')

/**
 * An `ArtifactStore` in an S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, Garage) through
 * Bun's built-in client. Metadata lives in a `<key>.json` sidecar object; `presign` gives
 * short-lived download URLs; `usage` lists the bucket, so it is cached for a minute by default.
 */
export function s3ArtifactStore(options: S3ArtifactStoreOptions): ArtifactStore {
  const client = new S3Client({
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    ...(options.virtualHostedStyle ? { virtualHostedStyle: true } : {}),
  })
  const root = options.prefix ? `${options.prefix.replace(/\/+$/, '')}/` : ''
  const dataKey = (id: string) => `${root}${fanout(id)}`
  const metaKey = (id: string) => `${dataKey(id)}.json`
  const concurrency = options.listConcurrency ?? 16

  const readMeta = (id: string) =>
    orMissing(async () => {
      const parsed: unknown = await client.file(metaKey(id)).json()
      return isArtifactInfo(parsed) ? parsed : undefined
    })

  return createArtifactStore(
    {
      readMeta,
      async writeMeta(info) {
        await client.write(metaKey(info.id), JSON.stringify(info), { type: 'application/json' })
      },
      async writeData(id, data, contentType) {
        await client.write(dataKey(id), data, { type: contentType })
      },
      readData: (id) =>
        orMissing(async () => new Uint8Array(await client.file(dataKey(id)).arrayBuffer())),
      async streamData(id) {
        const file = client.file(dataKey(id))
        return (await orMissing(() => file.exists())) ? file.stream() : undefined
      },
      async remove(id) {
        await orMissing(() => client.delete(metaKey(id)))
        await orMissing(() => client.delete(dataKey(id)))
      },
      async listMeta() {
        const ids: string[] = []
        let continuationToken: string | undefined
        do {
          const page = await client.list({
            prefix: root,
            ...(continuationToken ? { continuationToken } : {}),
          })
          for (const { key } of page.contents ?? []) {
            const id = key.slice(key.lastIndexOf('/') + 1, -'.json'.length)
            if (key.endsWith('.json') && isArtifactId(id) && key === metaKey(id)) ids.push(id)
          }
          continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
        } while (continuationToken)

        const infos: ArtifactInfo[] = []
        for (let i = 0; i < ids.length; i += concurrency) {
          const batch = await Promise.all(ids.slice(i, i + concurrency).map(readMeta))
          for (const info of batch) if (info) infos.push(info)
        }
        return infos
      },
      presign(info, { expiresIn = 300, filename }) {
        const name = filename ?? info.name?.split('/').at(-1)
        return client.presign(dataKey(info.id), {
          expiresIn,
          type: info.contentType,
          ...(name ? { contentDisposition: `attachment; filename="${quoteFilename(name)}"` } : {}),
        })
      },
    },
    { usageCacheMs: 60_000, ...options },
  )
}

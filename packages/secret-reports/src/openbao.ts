import { z } from 'zod'

import { secretFingerprint } from './fingerprint.ts'

const listSchema = z.object({ data: z.object({ keys: z.array(z.string()) }) })
const readSchema = z.object({
  data: z.object({
    data: z.record(z.string(), z.unknown()).nullish(),
    metadata: z.object({ version: z.number().optional() }).nullish(),
  }),
})

/** Where a fingerprint was found in an OpenBao (or Vault) KV v2 engine. */
export interface KvMatch {
  fingerprint: string
  /** Secret path under the mount, e.g. `widgets/api`. */
  path: string
  /** Field of the secret holding the value. */
  field: string
  version?: number
}

/** Options of `matchKvSecrets`. */
export interface MatchKvOptions {
  /** e.g. `https://bao.example.com:8200`. */
  address: string
  token: string
  /** KV v2 mount, e.g. `secret`. */
  mount: string
  /** Folder under the mount to start from; default the whole mount. */
  prefix?: string
  /** Enterprise or OpenBao namespace, sent as `X-Vault-Namespace`. */
  namespace?: string
  fingerprints: readonly string[]
  /** Default: global `fetch`. */
  fetch?: typeof fetch
  /** Reports every secret path read, for progress output. */
  onRead?: (path: string) => void
}

const joinPath = (...parts: string[]) =>
  parts
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')

/**
 * Walks the latest version of every secret of a KV v2 engine through the HTTP API (`LIST
 * metadata`, `GET data`, token in `X-Vault-Token`, which OpenBao and Vault both accept) and
 * returns the fields whose value has one of `fingerprints`. Values are hashed in memory and never
 * leave the process. Folders the token may not list or read are skipped; other HTTP errors throw.
 */
export async function matchKvSecrets(options: MatchKvOptions): Promise<KvMatch[]> {
  const wanted = new Set(options.fingerprints.map((value) => value.toLowerCase()))
  const call = options.fetch ?? fetch
  const base = options.address.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'x-vault-token': options.token,
    ...(options.namespace && { 'x-vault-namespace': options.namespace }),
  }
  const get = async (path: string): Promise<unknown> => {
    const response = await call(`${base}/v1/${path}`, { headers })
    if (response.status === 403 || response.status === 404) return undefined
    if (!response.ok) throw new Error(`GET /v1/${path}: HTTP ${response.status}`)
    return response.json()
  }

  const matches: KvMatch[] = []
  const walk = async (folder: string): Promise<void> => {
    const listed = listSchema.safeParse(
      await get(`${joinPath(options.mount, 'metadata', folder)}?list=true`),
    )
    if (!listed.success) return
    for (const key of listed.data.data.keys) {
      const path = folder ? `${folder.replace(/\/+$/, '')}/${key}` : key
      if (key.endsWith('/')) {
        await walk(path)
        continue
      }
      options.onRead?.(path)
      const read = readSchema.safeParse(await get(joinPath(options.mount, 'data', path)))
      const fields = (read.success && read.data.data.data) || {}
      const version = read.success ? read.data.data.metadata?.version : undefined
      for (const [field, value] of Object.entries(fields)) {
        if (typeof value !== 'string') continue
        const fingerprint = await secretFingerprint(value)
        if (wanted.has(fingerprint))
          matches.push({ fingerprint, path, field, ...(version !== undefined && { version }) })
      }
    }
  }
  await walk(options.prefix?.replace(/^\/+/, '') ?? '')
  return matches
}

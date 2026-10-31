import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

import type { Mount } from './types.ts'

/**
 * A forward HTTP proxy that job commands send their HTTP(S) traffic through, e.g. one that adds
 * registry credentials so jobs never hold them. Any proxy speaking plain HTTP and `CONNECT` works.
 */
export interface EgressProxy {
  /** `http://host:port` of the proxy. */
  url: string
  /** PEM certificate of the CA the proxy signs intercepted TLS connections with. */
  caFile?: string
  /** Hosts reached directly; `localhost`, `127.0.0.1` and `::1` always are. */
  noProxy?: readonly string[]
}

/** What a runner adds to its commands for an `EgressProxy`. */
export interface EgressEnvironment {
  /** Proxy and CA variables understood by npm, pnpm, yarn, bun, Node, git, curl, Go and Python. */
  env: Record<string, string>
  /** The CA files, when the runner is a container and `containerDir` was given. */
  mounts: Mount[]
}

export interface EgressEnvironmentOptions {
  /** Where the CA files appear inside a container; host paths are used when omitted. */
  containerDir?: string
  /** Where the combined CA bundle is written. Default: the system temp directory. */
  dir?: string
  /** Trust stores the CA is appended to; the first that exists wins. */
  systemBundles?: readonly string[]
}

const defaultSystemBundles = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
]

const write = (file: string, content: string) => {
  const partial = `${file}.${process.pid}.${crypto.randomUUID()}`
  writeFileSync(partial, content)
  renameSync(partial, file)
}

/**
 * The environment that routes a job's commands through `proxy`. With a `caFile`, Node gets it as
 * an extra CA, and tools that only read a whole trust store get the system one with the CA
 * appended, so hosts the proxy does not intercept keep verifying as before. Without a system trust
 * store only Node-based tools trust the CA.
 */
export function egressEnvironment(
  proxy: EgressProxy,
  options: EgressEnvironmentOptions = {},
): EgressEnvironment {
  const noProxy = ['localhost', '127.0.0.1', '::1', ...(proxy.noProxy ?? [])].join(',')
  const env: Record<string, string> = {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    YARN_HTTP_PROXY: proxy.url,
    YARN_HTTPS_PROXY: proxy.url,
  }
  if (!proxy.caFile) return { env, mounts: [] }

  const ca = readFileSync(proxy.caFile, 'utf8')
  const system = (options.systemBundles ?? defaultSystemBundles).find((file) => existsSync(file))
  const bundle = system ? `${readFileSync(system, 'utf8').trimEnd()}\n${ca}` : undefined
  const hash = createHash('sha256')
    .update(ca)
    .update(bundle ?? '')
    .digest('hex')
    .slice(0, 16)
  const hostDir = join(options.dir ?? tmpdir(), `holtkeeper-egress-${hash}`)
  mkdirSync(hostDir, { recursive: true })
  write(join(hostDir, 'ca.pem'), ca)
  if (bundle) write(join(hostDir, 'bundle.pem'), bundle)

  const dir = options.containerDir ?? hostDir
  const path = (file: string) => (options.containerDir ? posix.join(dir, file) : join(dir, file))
  env.NODE_EXTRA_CA_CERTS = path('ca.pem')
  if (bundle)
    for (const name of ['SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE'])
      env[name] = path('bundle.pem')
  const mounts = options.containerDir
    ? [{ hostDir, containerDir: options.containerDir, readOnly: true }]
    : []
  return { env, mounts }
}

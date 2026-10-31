import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const available = Boolean(Bun.which('mitmdump') && Bun.which('openssl'))
const addon = join(import.meta.dir, 'egress.py')
const token = 'test-token-value'
const placeholder = '0b6f3c1e-placeholder'

const rules = {
  rules: [
    {
      host: 'localhost',
      paths: ['^/packages/'],
      headers: { Authorization: 'Bearer ${EGRESS_TEST_TOKEN}' },
    },
    {
      host: 'localhost',
      insecure: true,
      paths: ['^/plain/'],
      headers: { 'X-Token': '${EGRESS_TEST_TOKEN}' },
    },
    {
      host: 'localhost',
      insecure: true,
      paths: ['^/cache/'],
      methods: ['*'],
      replace: { [placeholder]: '${EGRESS_TEST_TOKEN}' },
      in: ['headers', 'url'],
    },
  ],
}

async function freePort() {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = server
  server.stop(true)
  return port
}

function spawnProxy(
  dir: string,
  env: Record<string, string>,
  upstreamCa: string,
  port: number,
  args: string[] = [],
) {
  const proc = Bun.spawn(
    [
      'mitmdump',
      '--set',
      `confdir=${join(dir, 'mitm')}`,
      '--listen-host',
      '127.0.0.1',
      '--listen-port',
      String(port),
      '--set',
      `egress_rules=${join(dir, 'rules.json')}`,
      '--set',
      `ssl_verify_upstream_trusted_ca=${upstreamCa}`,
      '-s',
      addon,
      ...args,
    ],
    {
      env: { ...Bun.env, PYTHONUNBUFFERED: '1', EGRESS_TEST_TOKEN: undefined, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  let output = ''
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output += decoder.decode(chunk)
  }
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)])
  // On CI runners mitmdump's log only arrives when it exits, so readiness is the open port.
  const exited = async () => {
    await proc.exited
    await drained
    return output
  }
  return { proc, port, exited }
}

async function startProxy(
  dir: string,
  env: Record<string, string>,
  upstreamCa: string,
  args: string[] = [],
) {
  const proxy = spawnProxy(dir, env, upstreamCa, await freePort(), args)
  const deadline = Date.now() + 90_000
  while (proxy.proc.exitCode === null && Date.now() < deadline) {
    const open = await Bun.connect({
      hostname: '127.0.0.1',
      port: proxy.port,
      socket: { data() {} },
    }).then(
      (socket) => (socket.end(), true),
      () => false,
    )
    if (open) return proxy
    await Bun.sleep(200)
  }
  proxy.proc.kill()
  throw new Error(`mitmdump did not start: ${await proxy.exited()}`)
}

const rulesSecret = 'rules-secret'
let registryToken = 'registry-first'

const echo = (request: Request) => {
  const authorization = request.headers.get('authorization')
  if (
    new URL(request.url).pathname.startsWith('/registry/') &&
    authorization !== `Bearer ${registryToken}`
  )
    return Response.json({ authorization }, { status: 401 })
  return Response.json({
    authorization,
    token: request.headers.get('x-token'),
    query: new URL(request.url).search,
  })
}

const servedRules = (request: Request) =>
  request.headers.get('authorization') === `Bearer ${rulesSecret}`
    ? Response.json({
        rules: [
          {
            host: 'localhost',
            paths: ['^/registry/'],
            headers: { Authorization: `Bearer ${registryToken}` },
          },
        ],
      })
    : new Response('unauthorized', { status: 401 })

describe.skipIf(!available)('egress addon', () => {
  let dir: string
  let proxy: Awaited<ReturnType<typeof startProxy>>
  let tls: ReturnType<typeof Bun.serve>
  let plain: ReturnType<typeof Bun.serve>
  let rulesServer: ReturnType<typeof Bun.serve>
  let upstreamCert: string
  let proxyCa: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'egress-proxy-'))
    const key = join(dir, 'upstream.key')
    const cert = join(dir, 'upstream.crt')
    const openssl = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ])
    if (openssl.exitCode !== 0) throw new Error(openssl.stderr.toString())
    upstreamCert = await readFile(cert, 'utf8')
    tls = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch: echo,
    })
    plain = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: echo })
    rulesServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: servedRules })
    await writeFile(join(dir, 'rules.json'), JSON.stringify(rules))
    proxy = await startProxy(
      dir,
      {
        EGRESS_TEST_TOKEN: token,
        EGRESS_RULES_TOKEN: rulesSecret,
        EGRESS_CACHE_DIR: join(dir, 'cache'),
      },
      cert,
      [
        '--set',
        `egress_rules_url=http://127.0.0.1:${rulesServer.port}/rules`,
        '--set',
        'egress_rules_refresh=3600',
      ],
    )
    proxyCa = await readFile(join(dir, 'mitm', 'mitmproxy-ca-cert.pem'), 'utf8')
  }, 120_000)

  afterAll(async () => {
    proxy?.proc.kill()
    await proxy?.proc.exited
    await tls?.stop(true)
    await plain?.stop(true)
    await rulesServer?.stop(true)
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  const send = async (url: string, init: RequestInit & { ca?: string } = {}) => {
    const { ca, ...rest } = init
    const response = await fetch(url, {
      ...rest,
      proxy: `http://127.0.0.1:${proxy.port}`,
      ...(ca && { tls: { ca } }),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as {
      authorization: string | null
      token: string | null
      query: string
    }
  }

  test('adds the header to matching HTTPS requests and replaces the client one', async () => {
    const body = await send(`https://localhost:${tls.port}/packages/a.tgz`, {
      ca: proxyCa,
      headers: { Authorization: 'Bearer from-client' },
    })
    expect(body.authorization).toBe(`Bearer ${token}`)
  })

  test('leaves other paths and methods of a rule host alone', async () => {
    const other = await send(`https://localhost:${tls.port}/api/v4/user`, { ca: proxyCa })
    expect(other.authorization).toBeNull()
    const post = await send(`https://localhost:${tls.port}/packages/a.tgz`, {
      ca: proxyCa,
      method: 'POST',
    })
    expect(post.authorization).toBeNull()
  })

  test('tunnels TLS to hosts without rules untouched', async () => {
    const body = await send(`https://127.0.0.1:${tls.port}/packages/a.tgz`, { ca: upstreamCert })
    expect(body.authorization).toBeNull()
  })

  test('adds headers over plain HTTP only for insecure rules', async () => {
    expect((await send(`http://localhost:${plain.port}/plain/x`)).token).toBe(token)
    expect((await send(`http://localhost:${plain.port}/packages/x`)).authorization).toBeNull()
  })

  test('replaces placeholders in headers and the URL of matching requests only', async () => {
    const put = await send(`http://localhost:${plain.port}/cache/a?team=x&token=${placeholder}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${placeholder}` },
    })
    expect(put.authorization).toBe(`Bearer ${token}`)
    expect(put.query).toBe(`?team=x&token=${token}`)
    const elsewhere = await send(`http://localhost:${plain.port}/other`, {
      headers: { Authorization: `Bearer ${placeholder}` },
    })
    expect(elsewhere.authorization).toBe(`Bearer ${placeholder}`)
  })

  test('takes rules from a URL and re-reads them when the upstream refuses the token', async () => {
    const registry = `https://localhost:${tls.port}/registry/pkg.tgz`
    const authorization = async () => {
      const response = await fetch(registry, {
        proxy: `http://127.0.0.1:${proxy.port}`,
        tls: { ca: proxyCa },
      })
      return ((await response.json()) as { authorization: string | null }).authorization
    }
    expect(await authorization()).toBe('Bearer registry-first')
    registryToken = 'registry-rotated'
    expect(await authorization()).toBe('Bearer registry-first')
    let seen: string | null = null
    for (let attempt = 0; attempt < 50 && seen !== 'Bearer registry-rotated'; attempt++) {
      await Bun.sleep(200)
      seen = await authorization()
    }
    expect(seen).toBe('Bearer registry-rotated')
  }, 30_000)

  test('never logs header values', async () => {
    proxy.proc.kill()
    const output = await proxy.exited()
    for (const secret of [token, rulesSecret, 'registry-first', 'registry-rotated'])
      expect(output).not.toContain(secret)
  })

  test('refuses to start when a referenced variable is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'egress-proxy-'))
    try {
      await writeFile(join(empty, 'rules.json'), JSON.stringify(rules))
      const failed = spawnProxy(empty, {}, join(dir, 'upstream.crt'), await freePort())
      expect(await failed.exited()).toContain("environment variable 'EGRESS_TEST_TOKEN' is not set")
      expect(failed.proc.exitCode).not.toBe(0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  }, 120_000)
})

async function selfSigned(dir: string) {
  const key = join(dir, 'upstream.key')
  const cert = join(dir, 'upstream.crt')
  const openssl = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout',
    key,
    '-out',
    cert,
  ])
  if (openssl.exitCode !== 0) throw new Error(openssl.stderr.toString())
  return { key, cert }
}

const adminToken = 'admin-token-value'
const s3Keys = { access: 'AKIDTEST', secret: 'test-secret-key' }

const hmac = (key: Buffer | string, value: string) =>
  createHmac('sha256', key).update(value).digest()

/** Whether `url` carries a valid SigV4 query signature for the test keys. */
const signed = (url: URL, method: string, host: string) => {
  const raw = url.search.slice(1).split('&')
  const signature = raw.find((part) => part.startsWith('X-Amz-Signature='))?.split('=')[1]
  const query = raw.filter((part) => !part.startsWith('X-Amz-Signature=')).toSorted()
  const stamp = url.searchParams.get('X-Amz-Date') ?? ''
  const scope = `${stamp.slice(0, 8)}/us-east-1/s3/aws4_request`
  const canonical = [
    method,
    url.pathname,
    query.join('&'),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')
  let key: Buffer | string = `AWS4${s3Keys.secret}`
  for (const part of [stamp.slice(0, 8), 'us-east-1', 's3', 'aws4_request']) key = hmac(key, part)
  return signature === hmac(key, toSign).toString('hex')
}

/** An S3 lookalike that keeps objects in memory and refuses requests whose SigV4 query signature is wrong. */
function fakeS3() {
  const objects = new Map<string, { body: Uint8Array; modified: Date }>()
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      if (!signed(url, request.method, request.headers.get('host') ?? ''))
        return new Response('bad signature', { status: 403 })
      if (url.pathname === '/bucket' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? ''
        const contents = [...objects]
          .filter(([key]) => key.startsWith(prefix))
          .map(
            ([key, object]) =>
              `<Contents><Key>${Bun.escapeHTML(key)}</Key><LastModified>${object.modified.toISOString()}</LastModified><Size>${object.body.length}</Size></Contents>`,
          )
          .join('')
        return new Response(
          `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          { headers: { 'content-type': 'application/xml' } },
        )
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''))
      if (request.method === 'PUT') {
        objects.set(key, {
          body: new Uint8Array(await request.arrayBuffer()),
          modified: new Date(),
        })
        return new Response(null, { status: 200 })
      }
      if (request.method === 'DELETE') {
        objects.delete(key)
        return new Response(null, { status: 204 })
      }
      const object = objects.get(key)
      if (!object) return new Response('not found', { status: 404 })
      return new Response(request.method === 'HEAD' ? null : object.body, {
        headers: { 'content-length': String(object.body.length), 'x-amz-request-id': 'fake' },
      })
    },
  })
  return { server, objects, requests }
}

for (const backend of ['dir', 's3'] as const)
  describe.skipIf(!available)(`egress cache (${backend})`, () => {
    let dir: string
    let proxy: Awaited<ReturnType<typeof startProxy>>
    let upstream: ReturnType<typeof Bun.serve>
    let s3: ReturnType<typeof fakeS3> | undefined
    let proxyCa: string
    const served = new Map<string, number>()
    const payload = new Uint8Array(3 * 1024 * 1024).map((_, index) => (index * 31) % 251)

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'egress-cache-'))
      const { key, cert } = await selfSigned(dir)
      upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        tls: { key: Bun.file(key), cert: Bun.file(cert) },
        fetch(request) {
          const url = new URL(request.url)
          served.set(url.pathname, (served.get(url.pathname) ?? 0) + 1)
          if (url.pathname.startsWith('/redirect/'))
            return Response.redirect(
              `https://127.0.0.1:${url.port}/signed/${url.pathname.split('/').pop()}?sig=${Math.random()}`,
              302,
            )
          if (url.pathname === '/files/private.tgz')
            return new Response('nope', { headers: { 'cache-control': 'no-store' } })
          if (url.pathname === '/files/missing.tgz') return new Response('gone', { status: 404 })
          return new Response(payload, { headers: { 'content-type': 'application/x-tar' } })
        },
      })
      s3 = backend === 's3' ? fakeS3() : undefined
      await writeFile(
        join(dir, 'rules.json'),
        JSON.stringify({
          rules: [],
          cache: [
            { kind: 'packages', host: 'localhost', paths: ['^/files/'] },
            { kind: 'tools', host: 'localhost', paths: ['^/redirect/'] },
          ],
        }),
      )
      proxy = await startProxy(
        dir,
        {
          EGRESS_CACHE_DEFAULTS: 'off',
          EGRESS_CACHE_REDIRECT_HOSTS: '127.0.0.1',
          EGRESS_ADMIN_TOKEN: adminToken,
          EGRESS_CACHE_TTL_TOOLS: '3s',
          ...(s3
            ? {
                EGRESS_CACHE_S3_BUCKET: 'bucket',
                EGRESS_CACHE_S3_ENDPOINT: `http://127.0.0.1:${s3.server.port}`,
                EGRESS_CACHE_S3_PREFIX: 'egress',
                EGRESS_CACHE_S3_ACCESS_KEY_ID: s3Keys.access,
                EGRESS_CACHE_S3_SECRET_ACCESS_KEY: s3Keys.secret,
                EGRESS_CACHE_SPOOL: join(dir, 'spool'),
              }
            : { EGRESS_CACHE_DIR: join(dir, 'cache') }),
        },
        cert,
      )
      proxyCa = await readFile(join(dir, 'mitm', 'mitmproxy-ca-cert.pem'), 'utf8')
    }, 120_000)

    afterAll(async () => {
      proxy?.proc.kill()
      await proxy?.proc.exited
      await upstream?.stop(true)
      await s3?.server.stop(true)
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    const get = (path: string) =>
      fetch(`https://localhost:${upstream.port}${path}`, {
        proxy: `http://127.0.0.1:${proxy.port}`,
        tls: { ca: proxyCa },
      })

    const admin = (path: string, init: RequestInit = {}, secret = adminToken) =>
      fetch(`http://egress-cache.invalid${path}`, {
        ...init,
        proxy: `http://127.0.0.1:${proxy.port}`,
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      })

    const stored = async (path: string) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const view = (await (await admin('/v1/cache')).json()) as { entries: { url: string }[] }
        if (view.entries.some((entry) => entry.url.endsWith(path))) return
        await Bun.sleep(100)
      }
      throw new Error(`${path} was never stored`)
    }

    test('stores a complete download and serves the next one from the cache', async () => {
      const first = await get('/files/a.tgz')
      expect(first.headers.get('x-egress-cache')).toBe('miss')
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload)
      await stored('/files/a.tgz')
      const second = await get('/files/a.tgz')
      expect(second.status).toBe(200)
      expect(second.headers.get('x-egress-cache')).toBe('hit')
      expect(second.headers.get('content-type')).toBe('application/x-tar')
      expect(second.headers.get('x-amz-request-id')).toBeNull()
      expect(new Uint8Array(await second.arrayBuffer())).toEqual(payload)
      expect(served.get('/files/a.tgz')).toBe(1)
      if (s3)
        expect(s3.requests).toContain(
          `GET /bucket/egress/packages/localhost%3A${upstream.port}/files/a.tgz/%3Dbody`,
        )
    })

    test('never stores errors or no-store answers', async () => {
      for (const path of ['/files/private.tgz', '/files/missing.tgz']) {
        await (await get(path)).arrayBuffer()
        await (await get(path)).arrayBuffer()
        expect(served.get(path)).toBe(2)
      }
    })

    test('stores a redirected download under the URL that redirected', async () => {
      expect(new Uint8Array(await (await get('/redirect/tool.tar.gz')).arrayBuffer())).toEqual(
        payload,
      )
      await stored('/redirect/tool.tar.gz')
      const again = await get('/redirect/tool.tar.gz')
      expect(again.headers.get('x-egress-cache')).toBe('hit')
      expect(new Uint8Array(await again.arrayBuffer())).toEqual(payload)
      expect(served.get('/redirect/tool.tar.gz')).toBe(1)
      expect(served.get('/signed/tool.tar.gz')).toBe(1)
    })

    test('goes upstream again once an entry is unused for its TTL', async () => {
      await Bun.sleep(4_000)
      const expired = await get('/redirect/tool.tar.gz')
      expect(expired.headers.get('x-egress-cache')).toBe('miss')
      await expired.arrayBuffer()
      expect(served.get('/redirect/tool.tar.gz')).toBe(2)
    }, 15_000)

    test('reports and deletes entries behind the admin token', async () => {
      expect((await admin('/v1/cache', {}, 'wrong')).status).toBe(401)
      const view = (await (await admin('/v1/cache')).json()) as {
        backend: { kind: string }
        ttlSeconds: Record<string, number>
        stats: { hits: number }
        entries: { path: string; kind: string; size: number; hits: number }[]
      }
      expect(view.backend.kind).toBe(backend)
      expect(view.ttlSeconds).toEqual({ packages: 28 * 86400, tools: 3 })
      const entry = view.entries.find(
        (item) => item.path === `packages/localhost:${upstream.port}/files/a.tgz`,
      )
      expect(entry).toMatchObject({ kind: 'packages', size: payload.length, hits: 1 })
      const deleted = await admin('/v1/cache/delete', {
        method: 'POST',
        body: JSON.stringify({ paths: [entry?.path] }),
      })
      expect(await deleted.json()).toEqual({ removed: 1, bytes: payload.length })
      const after = await get('/files/a.tgz')
      expect(after.headers.get('x-egress-cache')).toBe('miss')
      await after.arrayBuffer()
      expect(served.get('/files/a.tgz')).toBe(2)
    })
  })

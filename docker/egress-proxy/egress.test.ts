import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const available = Boolean(Bun.which('mitmdump') && Bun.which('openssl'))
const addon = join(import.meta.dir, 'egress.py')
const token = 'test-token-value'

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
  ],
}

async function freePort() {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = server
  server.stop(true)
  return port
}

function spawnProxy(dir: string, env: Record<string, string>, upstreamCa: string, port: number) {
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

async function startProxy(dir: string, env: Record<string, string>, upstreamCa: string) {
  const proxy = spawnProxy(dir, env, upstreamCa, await freePort())
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

const echo = (request: Request) =>
  Response.json({
    authorization: request.headers.get('authorization'),
    token: request.headers.get('x-token'),
  })

describe.skipIf(!available)('egress addon', () => {
  let dir: string
  let proxy: Awaited<ReturnType<typeof startProxy>>
  let tls: ReturnType<typeof Bun.serve>
  let plain: ReturnType<typeof Bun.serve>
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
    await writeFile(join(dir, 'rules.json'), JSON.stringify(rules))
    proxy = await startProxy(dir, { EGRESS_TEST_TOKEN: token }, cert)
    proxyCa = await readFile(join(dir, 'mitm', 'mitmproxy-ca-cert.pem'), 'utf8')
  }, 120_000)

  afterAll(async () => {
    proxy?.proc.kill()
    await proxy?.proc.exited
    await tls?.stop(true)
    await plain?.stop(true)
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
    return (await response.json()) as { authorization: string | null; token: string | null }
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

  test('never logs header values', async () => {
    proxy.proc.kill()
    expect(await proxy.exited()).not.toContain(token)
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

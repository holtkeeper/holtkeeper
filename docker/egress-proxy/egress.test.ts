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

async function startProxy(dir: string, env: Record<string, string>, upstreamCa: string) {
  const port = await freePort()
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
  const { promise: listening, resolve } = Promise.withResolvers<boolean>()
  let output = ''
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout) {
      output += decoder.decode(chunk)
      if (output.includes('listening at')) resolve(true)
    }
    resolve(false)
  })()
  if (!(await listening) || output.includes('error in script')) {
    await proc.exited
    throw new Error(`mitmdump did not start: ${output}${await new Response(proc.stderr).text()}`)
  }
  return { proc, port, output: () => output }
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
  }, 60_000)

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

  test('never logs header values', () => {
    expect(proxy.output()).not.toContain(token)
  })

  test('refuses to start when a referenced variable is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'egress-proxy-'))
    try {
      await writeFile(join(empty, 'rules.json'), JSON.stringify(rules))
      const failure = await startProxy(empty, {}, join(dir, 'upstream.crt')).then(
        () => 'started',
        (error: unknown) => String(error),
      )
      expect(failure).toContain("environment variable 'EGRESS_TEST_TOKEN' is not set")
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  }, 60_000)
})

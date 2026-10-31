import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { egressEnvironment } from './egress.ts'

const ca = '-----BEGIN CERTIFICATE-----\nproxy\n-----END CERTIFICATE-----\n'
const system = '-----BEGIN CERTIFICATE-----\nsystem\n-----END CERTIFICATE-----\n'

describe('egressEnvironment', () => {
  let dir: string
  let caFile: string
  let systemFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'egress-'))
    caFile = join(dir, 'proxy-ca.pem')
    systemFile = join(dir, 'system.pem')
    await writeFile(caFile, ca)
    await writeFile(systemFile, system)
  })

  afterEach(() => rm(dir, { recursive: true, force: true }))

  test('routes through the proxy and keeps loopback direct', () => {
    const { env, mounts } = egressEnvironment({ url: 'http://proxy:8080', noProxy: ['.svc'] })
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080')
    expect(env.https_proxy).toBe('http://proxy:8080')
    expect(env.YARN_HTTPS_PROXY).toBe('http://proxy:8080')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,.svc')
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
    expect(mounts).toEqual([])
  })

  test('gives Node the CA and other tools the system trust store with it appended', async () => {
    const { env } = egressEnvironment(
      { url: 'http://proxy:8080', caFile },
      { dir, systemBundles: [join(dir, 'missing.pem'), systemFile] },
    )
    expect(await readFile(env.NODE_EXTRA_CA_CERTS ?? '', 'utf8')).toBe(ca)
    expect(await readFile(env.SSL_CERT_FILE ?? '', 'utf8')).toBe(`${system.trimEnd()}\n${ca}`)
    for (const name of ['CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE'])
      expect(env[name]).toBe(env.SSL_CERT_FILE)
  })

  test('without a system trust store only Node trusts the CA', () => {
    const { env } = egressEnvironment(
      { url: 'http://proxy:8080', caFile },
      { dir, systemBundles: [join(dir, 'missing.pem')] },
    )
    expect(env.NODE_EXTRA_CA_CERTS).toBeDefined()
    expect(env.SSL_CERT_FILE).toBeUndefined()
  })

  test('mounts the CA files read-only into a container', () => {
    const { env, mounts } = egressEnvironment(
      { url: 'http://proxy:8080', caFile },
      { dir, systemBundles: [systemFile], containerDir: '/etc/holtkeeper/egress' },
    )
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/holtkeeper/egress/ca.pem')
    expect(env.SSL_CERT_FILE).toBe('/etc/holtkeeper/egress/bundle.pem')
    expect(mounts).toEqual([
      {
        hostDir: expect.stringContaining(join(dir, 'holtkeeper-egress-')),
        containerDir: '/etc/holtkeeper/egress',
        readOnly: true,
      },
    ])
  })
})

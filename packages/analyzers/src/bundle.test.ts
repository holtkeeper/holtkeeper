import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AnalyzerContext } from '@holtkeeper/analyzer'
import type { BundleRecordData } from '@holtkeeper/bundles'
import { createFakeRunner } from '@holtkeeper/exec/testing'

import { bundleAnalyzer } from './bundle.ts'

const realFetch = globalThis.fetch
let dir: string | undefined

afterEach(async () => {
  globalThis.fetch = realFetch
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function checkout(files: Record<string, string>) {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-bundle-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  return dir
}

const tarball = async (files: Record<string, string>) =>
  Bun.gzipSync(
    await new Bun.Archive(
      Object.fromEntries(Object.entries(files).map(([path, text]) => [`package/${path}`, text])),
    ).bytes(),
  )

type Options = Parameters<typeof bundleAnalyzer.run>[0]['options']

function context(root: string, options: Partial<Options>, previous: BundleRecordData[] = []) {
  const { runner, calls } = createFakeRunner()
  const lines: string[] = []
  const value = {
    repo: { forge: 'work', path: 'web/libs' },
    dir: root,
    runner,
    options: bundleAnalyzer.options.parse(options),
    forge: { npmRegistry: (repo: string) => `https://gitlab.test/api/v4/projects/${repo}/npm/` },
    forgeAccess: { kind: 'gitlab', url: 'https://gitlab.test', token: 'secret', readOnly: true },
    history: {
      analyses: {
        list: () => Promise.resolve(previous.map((data, index) => ({ id: `p${index}`, data }))),
      },
    },
    log: (line: string) => lines.push(line),
  } as unknown as AnalyzerContext<Options>
  return { value, calls, lines }
}

test('measures published package versions from the registry the checkout names', async () => {
  const root = await checkout({
    'package.json': JSON.stringify({ name: 'libs', private: true, workspaces: ['packages/*'] }),
    '.npmrc': '@acme:registry=https://gitlab.test/api/v4/groups/web/-/packages/npm/\n',
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', version: '1.1.0' }),
    'packages/app/package.json': JSON.stringify({ name: 'app', private: true, version: '0.0.0' }),
  })
  const registry = 'https://gitlab.test/api/v4/groups/web/-/packages/npm'
  const versions = ['0.9.0', '1.0.0', '1.1.0', '1.2.0-beta.1']
  const requests: { url: string; auth: string | null }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    requests.push({ url, auth: new Headers(init?.headers).get('authorization') })
    if (url === `${registry}/@acme%2Fui`)
      return Response.json({
        name: '@acme/ui',
        versions: Object.fromEntries(
          versions.map((version) => [
            version,
            { version, dist: { tarball: `${registry}/@acme/ui/-/ui-${version}.tgz` } },
          ]),
        ),
        time: Object.fromEntries(
          versions.map((version, index) => [version, `2026-0${index + 1}-01T00:00:00Z`]),
        ),
      })
    const version = /ui-(.+)\.tgz$/.exec(url)?.[1]
    if (version)
      return new Response(
        await tarball({
          'package.json': JSON.stringify({ name: '@acme/ui', version, main: 'index.js' }),
          'index.js': `export const ui = ${JSON.stringify('x'.repeat(version.length * 100))}\n`,
          'index.d.ts': 'export declare const ui: string\n',
        }),
      )
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const measured: BundleRecordData = {
    targets: [{ name: '@acme/ui', source: 'package', version: '1.0.0', status: 'ok' }],
  }
  const { value, calls } = context(root, { history: 5 }, [measured])
  const { data } = await bundleAnalyzer.run(value)
  const targets = data.targets
  expect(targets.map((target) => [target.name, target.version, target.status])).toEqual([
    ['@acme/ui', '1.1.0', 'ok'],
    ['@acme/ui', '0.9.0', 'ok'],
  ])
  expect(targets[0]?.at).toBe('2026-03-01T00:00:00Z')
  expect(targets[0]?.data?.assets.map((asset) => asset.file)).toEqual(['index.js'])
  expect(targets[0]?.data?.entrypoints.map((entry) => entry.name)).toEqual(['.'])
  expect(requests.every((request) => request.auth === 'Bearer secret')).toBeTrue()
  expect(calls).toEqual([])
})

test('builds an app with several entrypoints and keeps a failed build as a gap', async () => {
  const root = await checkout({
    'package.json': JSON.stringify({
      name: 'game',
      private: true,
      scripts: { build: 'vite build' },
    }),
    'pnpm-lock.yaml': '',
    'vite.config.ts': 'export default {}\n',
  })
  const { value, calls } = context(root, { install: false })
  const fail = await bundleAnalyzer.run(value)
  expect(fail.data.targets).toMatchObject([{ name: 'app', source: 'build', status: 'failed' }])
  expect(calls[0]?.command).toEqual(['sh', '-c', 'pnpm run build'])

  await mkdir(join(root, 'dist/.vite'), { recursive: true })
  await writeFile(join(root, 'dist/desktop.js'), 'console.log("desktop")\n')
  await writeFile(join(root, 'dist/mobile.js'), 'console.log("mobile")\n')
  await writeFile(
    join(root, 'dist/.vite/manifest.json'),
    JSON.stringify({
      'src/desktop.ts': { file: 'desktop.js', name: 'desktop', isEntry: true },
      'src/mobile.ts': { file: 'mobile.js', name: 'mobile', isEntry: true },
    }),
  )
  const ok = await bundleAnalyzer.run(value)
  const [app] = ok.data.targets
  expect(app?.status).toBe('ok')
  expect(app?.data?.entrypoints.map((entry) => entry.name).toSorted()).toEqual([
    'desktop',
    'mobile',
  ])
})

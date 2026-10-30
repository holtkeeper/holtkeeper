import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { detectToolchain } from './detect.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string | object>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-toolchain-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(
      join(dir, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    )
  }
  return dir
}

const versions = (toolchain: { tools: { name: string; version: string }[] }) =>
  Object.fromEntries(toolchain.tools.map((tool) => [tool.name, tool.version]))

describe('detectToolchain', () => {
  test('an empty directory needs nothing', async () => {
    expect(await detectToolchain(await fixture({}))).toEqual({ tools: [], notes: [] })
  })

  test('reads mise.toml tools in every value form', async () => {
    const dir = await fixture({
      'mise.toml': `[tools]
node = "20.11.1"
python = ["3.12", "3.11"]
go = { version = "1.22.3" }
"npm:prettier" = "3"
ruby = "system"
`,
    })
    const toolchain = await detectToolchain(dir)
    expect(toolchain.tools).toEqual([
      { name: 'node', version: '20.11.1', source: 'mise.toml' },
      { name: 'python', version: '3.12', source: 'mise.toml' },
      { name: 'go', version: '1.22.3', source: 'mise.toml' },
      { name: 'npm:prettier', version: '3', source: 'mise.toml' },
    ])
  })

  test('mise.local.toml beats mise.toml, which beats .tool-versions', async () => {
    const dir = await fixture({
      'mise.local.toml': '[tools]\nnode = "22"\n',
      'mise.toml': '[tools]\nnode = "20"\n',
      '.tool-versions': 'nodejs 18.0.0\ngolang 1.21.0 # comment\npython system 3.11.4\n',
    })
    const toolchain = await detectToolchain(dir)
    expect(versions(toolchain)).toEqual({ node: '22', go: '1.21.0', python: '3.11.4' })
    expect(toolchain.tools[0]?.source).toBe('mise.local.toml')
    expect(toolchain.notes).toEqual([
      'mise.toml asks for node 20; using 22 from mise.local.toml',
      '.tool-versions asks for node 18.0.0; using 22 from mise.local.toml',
    ])
  })

  test('corepack packageManager with a hash', async () => {
    const dir = await fixture({
      'package.json': { packageManager: 'pnpm@9.12.0+sha512.abc', engines: { node: '>=20' } },
      '.nvmrc': 'v20\n',
    })
    const toolchain = await detectToolchain(dir)
    expect(toolchain.tools).toEqual([
      { name: 'pnpm', version: '9.12.0', source: 'package.json' },
      { name: 'node', version: '20', source: '.nvmrc' },
    ])
    expect(toolchain.packageManager).toEqual({ name: 'pnpm', version: '9.12.0' })
    expect(toolchain.notes).toEqual([])
  })

  test('npm as packageManager is not a separate tool', async () => {
    const dir = await fixture({ 'package.json': { packageManager: 'npm@10.2.0' }, '.nvmrc': '20' })
    const toolchain = await detectToolchain(dir)
    expect(versions(toolchain)).toEqual({ node: '20' })
    expect(toolchain.packageManager).toEqual({ name: 'npm', version: '10.2.0' })
  })

  test('.nvmrc handles lts aliases; .node-version is the next choice', async () => {
    expect(versions(await detectToolchain(await fixture({ '.nvmrc': 'lts/*' })))).toEqual({
      node: 'lts',
    })
    expect(versions(await detectToolchain(await fixture({ '.node-version': '18.19.0' })))).toEqual({
      node: '18.19.0',
    })
    const bad = await detectToolchain(await fixture({ '.nvmrc': 'whatever' }))
    expect(bad.tools).toEqual([])
    expect(bad.notes).toEqual(['.nvmrc: cannot use "whatever"'])
  })

  test('engines.node picks the newest major in range when nothing pins node', async () => {
    const toolchain = await detectToolchain(
      await fixture({ 'package.json': { engines: { node: '>=18 <23' } } }),
    )
    expect(toolchain.tools).toEqual([{ name: 'node', version: '22', source: 'package.json' }])
  })

  test('a volta pin wins over an engines range and is checked against it', async () => {
    const ok = await detectToolchain(
      await fixture({
        'package.json': { engines: { node: '>=18' }, volta: { node: '20.11.0', yarn: '4.1.0' } },
      }),
    )
    expect(versions(ok)).toEqual({ node: '20.11.0', yarn: '4.1.0' })
    expect(ok.notes).toEqual([])

    const off = await detectToolchain(
      await fixture({ 'package.json': { engines: { node: '^22' } }, '.nvmrc': '20' }),
    )
    expect(versions(off)).toEqual({ node: '20' })
    expect(off.notes).toEqual([
      'node 20 from .nvmrc does not satisfy engines.node "^22" in package.json',
    ])
  })

  test('bun.lock implies bun, versioned by packageManager when present', async () => {
    const plain = await detectToolchain(await fixture({ 'bun.lock': '{}', 'package.json': {} }))
    expect(plain.tools).toEqual([
      { name: 'bun', version: 'latest', source: 'bun.lock' },
      { name: 'node', version: 'lts', source: 'package.json' },
    ])
    expect(plain.packageManager).toEqual({ name: 'bun' })

    const pinned = await detectToolchain(
      await fixture({ 'bun.lockb': '', 'package.json': { packageManager: 'bun@1.1.30' } }),
    )
    expect(versions(pinned)).toEqual({ bun: '1.1.30', node: 'lts' })
    expect(pinned.notes).toEqual(['node lts: no version pinned, implied by package.json'])
  })

  test('lockfiles imply package managers', async () => {
    const pnpm = await detectToolchain(await fixture({ 'pnpm-lock.yaml': '', '.nvmrc': '20' }))
    expect(versions(pnpm)).toEqual({ node: '20', pnpm: 'latest' })
    expect(pnpm.packageManager).toEqual({ name: 'pnpm' })
    const yarn = await detectToolchain(
      await fixture({ 'yarn.lock': '# yarn lockfile v1\n', '.nvmrc': '20' }),
    )
    expect(versions(yarn)).toEqual({ node: '20', yarn: '1' })
    const npm = await detectToolchain(await fixture({ 'package-lock.json': '{}', '.nvmrc': '20' }))
    expect(npm.packageManager).toEqual({ name: 'npm' })
  })

  test('go.mod: toolchain directive wins over the go line', async () => {
    const both = await detectToolchain(
      await fixture({ 'go.mod': 'module x\n\ngo 1.22\n\ntoolchain go1.22.5\n' }),
    )
    expect(both.tools).toEqual([{ name: 'go', version: '1.22.5', source: 'go.mod' }])
    const plain = await detectToolchain(await fixture({ 'go.mod': 'module x\ngo 1.21.0\n' }))
    expect(versions(plain)).toEqual({ go: '1.21.0' })
  })

  test('python from .python-version, then requires-python, plus poetry and uv', async () => {
    const pinned = await detectToolchain(
      await fixture({
        '.python-version': '3.11.9\n',
        'pyproject.toml': '[project]\nrequires-python = ">=3.10"\n',
        'uv.lock': '',
      }),
    )
    expect(versions(pinned)).toEqual({ python: '3.11.9', uv: 'latest' })
    expect(pinned.notes).toEqual(['uv latest: no version pinned, implied by uv.lock'])

    const ranged = await detectToolchain(
      await fixture({
        'pyproject.toml':
          '[tool.poetry]\nname = "x"\n[tool.poetry.dependencies]\npython = "^3.10,<3.13"\n',
      }),
    )
    expect(versions(ranged)).toEqual({ python: '3.12', poetry: 'latest' })

    const conflict = await detectToolchain(
      await fixture({
        '.python-version': '3.9',
        'pyproject.toml': '[project]\nrequires-python = ">=3.10"\n',
      }),
    )
    expect(conflict.notes).toEqual([
      'python 3.9 from .python-version does not satisfy requires-python ">=3.10" in pyproject.toml',
    ])
  })

  test('rust from rust-toolchain.toml or the legacy file; Cargo.toml implies stable', async () => {
    expect(
      versions(
        await detectToolchain(
          await fixture({ 'rust-toolchain.toml': '[toolchain]\nchannel = "1.79.0"\n' }),
        ),
      ),
    ).toEqual({ rust: '1.79.0' })
    expect(
      versions(await detectToolchain(await fixture({ 'rust-toolchain': 'nightly-2024-05-01\n' }))),
    ).toEqual({ rust: 'nightly-2024-05-01' })
    expect(
      versions(await detectToolchain(await fixture({ 'Cargo.toml': '[package]\nname = "x"\n' }))),
    ).toEqual({ rust: 'stable' })
  })

  test('java, sdkman and ruby', async () => {
    expect(versions(await detectToolchain(await fixture({ '.java-version': '1.8\n' })))).toEqual({
      java: '8',
    })
    const sdkman = await detectToolchain(
      await fixture({ '.sdkmanrc': '# comment\njava=21.0.2-tem\nmaven=3.9.6\n' }),
    )
    expect(versions(sdkman)).toEqual({ java: 'temurin-21.0.2', maven: '3.9.6' })
    expect(
      versions(await detectToolchain(await fixture({ '.ruby-version': 'ruby-3.3.0\n' }))),
    ).toEqual({ ruby: '3.3.0' })
  })

  test('malformed files are noted, not thrown', async () => {
    const toolchain = await detectToolchain(
      await fixture({ 'mise.toml': '[tools\nnode=', 'package.json': '{', 'pyproject.toml': '[[' }),
    )
    expect(versions(toolchain)).toEqual({ node: 'lts' })
    expect(toolchain.notes).toEqual([
      'mise.toml: not valid TOML, ignored',
      'package.json: not valid JSON, ignored',
      'pyproject.toml: not valid TOML, ignored',
      'node lts: no version pinned, implied by package.json',
    ])
  })

  describe('monorepos', () => {
    const files = {
      '.nvmrc': '20',
      'package.json': { packageManager: 'pnpm@9.12.0' },
      'apps/web/.nvmrc': '18',
      'apps/web/package.json': {},
      'services/api/go.mod': 'module api\ngo 1.22.1\n',
      'services/worker/go.mod': 'module worker\ngo 1.21.0\n',
      'node_modules/x/.nvmrc': '12',
    }

    test('the root wins; sub-projects add tools and conflicts become notes', async () => {
      const toolchain = await detectToolchain(await fixture(files))
      expect(toolchain.tools).toEqual([
        { name: 'pnpm', version: '9.12.0', source: 'package.json' },
        { name: 'node', version: '20', source: '.nvmrc' },
        { name: 'go', version: '1.22.1', source: 'services/api/go.mod' },
      ])
      expect(toolchain.notes).toEqual([
        'apps/web/.nvmrc asks for node 18; using 20 from .nvmrc',
        'services/worker/go.mod asks for go 1.21.0; using 1.22.1 from services/api/go.mod',
      ])
    })

    test('a given file list replaces walking the tree', async () => {
      const dir = await fixture(files)
      const toolchain = await detectToolchain(dir, ['.nvmrc', 'package.json', 'apps/web/.nvmrc'])
      expect(versions(toolchain)).toEqual({ pnpm: '9.12.0', node: '20' })
    })

    test('sub-project pins beat an implied root default', async () => {
      const toolchain = await detectToolchain(
        await fixture({ 'package.json': {}, 'packages/a/.nvmrc': '22' }),
      )
      expect(toolchain.tools).toEqual([
        { name: 'node', version: '22', source: 'packages/a/.nvmrc' },
      ])
    })

    test('notes from sub-projects carry their path', async () => {
      const toolchain = await detectToolchain(await fixture({ 'packages/a/package.json': '{' }))
      expect(toolchain.notes).toEqual([
        'packages/a/package.json: not valid JSON, ignored',
        'node lts: no version pinned, implied by packages/a/package.json',
      ])
    })
  })
})

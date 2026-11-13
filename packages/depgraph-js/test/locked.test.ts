import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  findLockfile,
  indexLockfile,
  lockfileOf,
  readJsWorkspaces,
  workspacesOf,
} from '../src/index.ts'

const fixtures = join(import.meta.dir, 'fixtures')

describe.each(['npm', 'bun', 'pnpm', 'yarn-classic', 'yarn-berry'] as const)(
  'indexLockfile on the %s fixture',
  (manager) => {
    const dir = join(fixtures, manager)

    test('resolves importer dependencies and lists package versions', async () => {
      const lockfile = await findLockfile(dir)
      if (!lockfile) throw new Error('no lockfile')
      const index = indexLockfile(
        lockfile,
        await Bun.file(join(dir, lockfile.file)).text(),
        await readJsWorkspaces(dir),
      )
      expect(index.packages.get('debug')).toEqual(['2.6.9', '4.4.3'])
      expect(index.packages.get('ms')).toEqual(['2.0.0', '2.1.3'])
      const a = index.importers.get('packages/a')
      expect(a?.dependencies.get('debug')?.version).toBe('4.4.3')
      expect(a?.dependencies.get('@fx/b')?.version).toBe('workspace:packages/b')
      expect(index.importers.get('packages/c')?.dependencies.get('finalhandler')?.version).toBe(
        '1.2.0',
      )
      if (manager === 'yarn-classic') expect(a?.recorded).toBe(false)
      else {
        expect(a?.recorded).toBe(true)
        expect(a?.dependencies.get('debug')?.specifier).toBe(
          manager === 'yarn-berry' ? 'npm:^4.3.0' : '^4.3.0',
        )
      }
    })
  },
)

test('a dependency the lockfile does not record has no version', async () => {
  const dir = join(fixtures, 'npm')
  const lock = await Bun.file(join(dir, 'package-lock.json')).json()
  const workspaces = await readJsWorkspaces(dir)
  const manifests = new Map([
    ['.', workspaces.root.manifest],
    ...workspaces.packages.map((pkg) => [pkg.path, pkg.manifest] as const),
  ])
  manifests.set('packages/a', {
    ...manifests.get('packages/a'),
    dependencies: { debug: '^4.3.0', 'left-widget': '^1.0.0' },
  })
  const npm = lockfileOf('package-lock.json')
  if (!npm) throw new Error('package-lock.json is not a known lockfile')
  const index = indexLockfile(npm, JSON.stringify(lock), workspacesOf(manifests))
  expect(index.importers.get('packages/a')?.dependencies.get('left-widget')).toBeUndefined()
  expect(index.packages.has('left-widget')).toBe(false)
})

test('lockfileOf matches by base name', () => {
  expect(lockfileOf('apps/web/pnpm-lock.yaml')?.manager).toBe('pnpm')
  expect(lockfileOf('yarn.lock')?.manager).toBe('yarn')
  expect(lockfileOf('bun.lockb')).toBeUndefined()
})

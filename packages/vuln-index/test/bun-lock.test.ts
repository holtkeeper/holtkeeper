import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeDependencies } from '@holtkeeper/depgraph'
import { jsSources } from '@holtkeeper/depgraph-js'
import type { OsvClient, OsvRecord } from '@holtkeeper/vuln-osv'

import { inventoryOf } from '../src/inventory.ts'
import { matchPackages } from '../src/match.ts'
import { indexAuditReport } from '../src/report.ts'

const manifest = {
  name: 'shapes-app',
  private: true,
  workspaces: ['packages/*'],
  dependencies: {
    '@acme/widget': 'workspace:*',
    lodash: '4.17.20',
    'minimist-alias': 'npm:minimist@1.2.5',
  },
  devDependencies: { debug: '2.6.8' },
}

// Written by `bun install --lockfile-only` (bun 1.4) for the manifests above; integrity hashes cut.
const bunLock = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "shapes-app",
      "dependencies": {
        "@acme/widget": "workspace:*",
        "lodash": "4.17.20",
        "minimist-alias": "npm:minimist@1.2.5",
      },
      "devDependencies": {
        "debug": "2.6.8",
      },
    },
    "packages/widget": {
      "name": "@acme/widget",
      "version": "1.0.0",
      "dependencies": {
        "ms": "2.0.0",
      },
    },
  },
  "packages": {
    "@acme/widget": ["@acme/widget@workspace:packages/widget"],

    "debug": ["debug@2.6.8", "", { "dependencies": { "ms": "2.0.0" } }, "sha512-x"],

    "lodash": ["lodash@4.17.20", "", {}, "sha512-x"],

    "minimist-alias": ["minimist@1.2.5", "", {}, "sha512-x"],

    "ms": ["ms@2.0.0", "", {}, "sha512-x"],
  }
}
`

const advisory = (id: string, name: string, fixed: string): OsvRecord => ({
  id,
  affected: [
    {
      package: { name, ecosystem: 'npm' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }],
    },
  ],
})

const advisories: Record<string, OsvRecord> = {
  'lodash@4.17.20': advisory('GHSA-1111-1111-1111', 'lodash', '4.17.21'),
  'minimist@1.2.5': advisory('GHSA-2222-2222-2222', 'minimist', '1.2.6'),
}

const client: OsvClient = {
  queryBatch: async (queries) =>
    queries.map((query) => {
      const found = advisories[`${query.name}@${query.version}`]
      return found ? [{ id: found.id, modified: '2026-01-01T00:00:00Z' }] : []
    }),
  vulnerability: async (id) => Object.values(advisories).find((record) => record.id === id),
}

const memoryCache = () => {
  const entries = new Map<string, { modified: string; record: OsvRecord }>()
  return {
    get: async (id: string) => entries.get(id),
    set: async (id: string, entry: { modified: string; record: OsvRecord }) => {
      entries.set(id, entry)
    },
  }
}

describe('bun.lock', () => {
  test('a text bun.lock is audited from its dependency graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vuln-index-bun-'))
    try {
      await mkdir(join(dir, 'packages/widget'), { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
      await writeFile(
        join(dir, 'packages/widget/package.json'),
        JSON.stringify({ name: '@acme/widget', version: '1.0.0', dependencies: { ms: '2.0.0' } }),
      )
      await writeFile(join(dir, 'bun.lock'), bunLock)

      const inventory = inventoryOf(await analyzeDependencies({ dir, sources: jsSources() }))
      expect(inventory.problem).toBeUndefined()
      expect(
        inventory.packages.map((pkg) => `${pkg.name}@${pkg.version} ${pkg.source}`).toSorted(),
      ).toEqual([
        'debug@2.6.8 bun.lock',
        'lodash@4.17.20 bun.lock',
        'minimist@1.2.5 bun.lock',
        'ms@2.0.0 bun.lock',
      ])

      const { records } = await matchPackages({
        client,
        cache: memoryCache(),
        packages: inventory.packages,
      })
      const report = indexAuditReport({ packages: inventory.packages, records })
      expect(
        report.findings.map((finding) => [finding.id, finding.package.name, finding.source]),
      ).toEqual([
        ['GHSA-1111-1111-1111', 'lodash', 'bun.lock'],
        ['GHSA-2222-2222-2222', 'minimist', 'bun.lock'],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { type ApiPackage, extractApi } from '@holtkeeper/api-surface'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { LibraryEcosystem, LibraryRef } from '@holtkeeper/store'

import { goApi } from '../go/api.ts'
import { modulePathOf } from '../go/module.ts'
import type { ArchiveFiles } from '../types.ts'
import {
  type SourceOutcome,
  type SourceTarget,
  artifactName,
  artifactTags,
  refOf,
  sourceStatus,
} from './shared.ts'

/** Reads the API of one version from its unpacked archive. */
export type ApiExtractor = (
  ref: LibraryRef,
  version: string,
  files: ArchiveFiles,
) => Promise<ApiPackage[]>

const apiFile = /(^|\/)package\.json$|\.d\.[cm]?ts$/i

/** `extractApi` over the declaration files and `package.json` of an npm archive, in a temp folder. */
export const npmApiExtractor: ApiExtractor = async (_ref, _version, files) => {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-api-'))
  try {
    const written = [...files].filter(([path]) => apiFile.test(path))
    await Promise.all(
      written.map(async ([path, data]) => {
        const target = join(dir, path)
        await mkdir(dirname(target), { recursive: true })
        await Bun.write(target, data)
      }),
    )
    if (!files.has('package.json')) return []
    return await extractApi({ dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Go API from the `.go` files of a module zip. */
export const goApiExtractor: ApiExtractor = async (ref, version, files) =>
  goApi(files, { version, module: modulePathOf(ref.name, version) })

/** Extractors used when the indexer is given none: npm declarations and Go sources. */
export const defaultApiExtractors: Partial<Record<LibraryEcosystem, ApiExtractor>> = {
  npm: npmApiExtractor,
  Go: goApiExtractor,
}

/**
 * Source `api`: the version's API as JSON `ApiPackage[]` in the artifact store; the outcome's
 * `patch.api` is the artifact id. `missing` when the archive has no API to read.
 */
export async function apiSource(
  artifacts: ArtifactStore,
  target: SourceTarget,
  files: ArchiveFiles | undefined,
  extractor: ApiExtractor | undefined,
): Promise<SourceOutcome> {
  if (!extractor)
    return {
      status: sourceStatus(
        'skipped',
        target.now,
        `no API extractor for ${target.library.ecosystem}`,
      ),
    }
  if (!files) return { status: sourceStatus('missing', target.now, 'no archive') }
  const ref = refOf(target.library)
  const version = target.version.version
  const packages = await extractor(ref, version, files)
  if (!packages.length)
    return { status: sourceStatus('missing', target.now, 'no declarations in the archive') }
  const { id } = await artifacts.put(new TextEncoder().encode(JSON.stringify(packages)), {
    contentType: 'application/json',
    name: artifactName(ref, version, 'api.json'),
    tags: artifactTags(ref, version, 'api'),
  })
  return { status: sourceStatus('ok', target.now), patch: { api: id } }
}

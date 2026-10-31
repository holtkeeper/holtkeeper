import { type ApiPackage, apiSurfaceDataSchema } from '@holtkeeper/api-surface'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { LibraryRef, LibraryStore } from '@holtkeeper/store'

/** API surfaces of indexed third-party library versions, for `get_package_api` and its kin. */
export interface LibraryApi {
  /** The API of one version; `undefined` when the version or its API is not indexed. */
  get(ref: LibraryRef, version: string): Promise<ApiPackage[] | undefined>
  /** Indexed versions that have an API, highest first. */
  versions(ref: LibraryRef): Promise<string[]>
}

/** `LibraryApi` over the library store and the artifacts the indexer's `api` source wrote. */
export function libraryApi(options: { store: LibraryStore; artifacts: ArtifactStore }): LibraryApi {
  return {
    async get(ref, version) {
      const record =
        (await options.store.getVersion(ref, version)) ??
        (await options.store.getVersion(
          ref,
          version.startsWith('v') ? version.slice(1) : `v${version}`,
        ))
      if (!record?.api) return undefined
      const artifact = await options.artifacts.get(record.api)
      if (!artifact) return undefined
      try {
        const packages: unknown = JSON.parse(new TextDecoder().decode(artifact.data))
        const parsed = apiSurfaceDataSchema.safeParse({ packages })
        return parsed.success ? parsed.data.packages : undefined
      } catch {
        return undefined
      }
    },
    async versions(ref) {
      return (await options.store.listVersions(ref))
        .filter((record) => record.api)
        .map((record) => record.version)
    },
  }
}

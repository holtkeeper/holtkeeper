import { libraryOfModule } from '@holtkeeper/go-source'
import type { LibraryEcosystem, LibraryRecord, LibraryRef, LibraryStore } from '@holtkeeper/store'

import { isGoModuleName } from './tags.ts'

/** A library name as tools pass it, resolved to the index's key. */
export interface ResolvedLibrary {
  /** The key the index stores the library under, or the best guess when it is not indexed. */
  ref: LibraryRef
  library?: LibraryRecord
}

/**
 * The indexed library a tool argument names. Without `ecosystem`, a name with a `/`, a dotted
 * first element and no `@scope` is Go, anything else npm. A Go name may carry its major suffix
 * (`/v2`) or be a package import path inside the module: the longest indexed module path that
 * prefixes it wins, compared without `/vN`.
 */
export async function resolveLibrary(
  store: Pick<LibraryStore, 'getLibrary'>,
  query: { package: string; ecosystem?: LibraryEcosystem | undefined },
): Promise<ResolvedLibrary> {
  const name = query.package.trim()
  const ecosystem = query.ecosystem ?? (isGoModuleName(name) ? 'Go' : 'npm')
  if (ecosystem !== 'Go') {
    const ref = { ecosystem, name }
    const library = await store.getLibrary(ref)
    return library ? { ref, library } : { ref }
  }
  const elements = name.replace(/\/+$/, '').split('/')
  const first = { ecosystem, name: libraryOfModule(name) }
  for (let count = elements.length; count >= 2; count--) {
    const ref = { ecosystem, name: libraryOfModule(elements.slice(0, count).join('/')) }
    if (
      count < elements.length &&
      ref.name === libraryOfModule(elements.slice(0, count + 1).join('/'))
    )
      continue
    // oxlint-disable-next-line no-await-in-loop -- the longest indexed prefix wins
    const library = await store.getLibrary(ref)
    if (library) return { ref, library }
  }
  return { ref: first }
}

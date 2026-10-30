import { type StoreOptions, createArtifactStore } from './core.ts'
import type { ArtifactInfo, ArtifactRef, ArtifactStore } from './types.ts'

/** An `ArtifactStore` in process memory, for tests and short-lived tools. */
export function memoryArtifactStore(options: StoreOptions = {}): ArtifactStore {
  const meta = new Map<string, ArtifactInfo>()
  const data = new Map<string, Uint8Array>()
  const refs = new Map<string, ArtifactRef>()
  return createArtifactStore(
    {
      readMeta: async (id) => meta.get(id),
      writeMeta: async (info) => {
        meta.set(info.id, info)
      },
      writeData: async (id, bytes) => {
        data.set(id, bytes.slice())
      },
      readData: async (id) => data.get(id)?.slice(),
      streamData: async (id) => {
        const bytes = data.get(id)
        return bytes ? new Blob([bytes.slice()]).stream() : undefined
      },
      remove: async (id) => {
        meta.delete(id)
        data.delete(id)
      },
      listMeta: async () => [...meta.values()],
      readRef: async (name) => refs.get(name),
      writeRef: async (name, ref) => {
        refs.set(name, ref)
      },
      removeRef: async (name) => {
        refs.delete(name)
      },
    },
    options,
  )
}

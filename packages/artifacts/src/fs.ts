import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type StoreOptions,
  createArtifactStore,
  fanout,
  isArtifactId,
  isArtifactInfo,
  isArtifactRef,
} from './core.ts'
import type { ArtifactInfo, ArtifactStore } from './types.ts'

export interface FsArtifactStoreOptions extends StoreOptions {
  /**
   * Root directory; created when missing. Content lives at `<dir>/ab/cd/<id>`, metadata next to it
   * as `<id>.json`, refs at `<dir>/refs/<name>.json`.
   */
  dir: string
}

async function writeAtomically(path: string, data: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await Bun.write(temp, data)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

const listDir = (path: string) => readdir(path).catch(() => [] as string[])

/**
 * An `ArtifactStore` on the local filesystem. Writes go to a temporary file renamed into place, so
 * readers never see partial content, and the metadata sidecar is written last.
 */
export function fsArtifactStore(options: FsArtifactStoreOptions): ArtifactStore {
  const { dir } = options
  const dataPath = (id: string) => join(dir, fanout(id))
  const metaPath = (id: string) => `${dataPath(id)}.json`
  const refPath = (name: string) => join(dir, 'refs', `${name}.json`)

  const readMeta = async (id: string): Promise<ArtifactInfo | undefined> => {
    const file = Bun.file(metaPath(id))
    if (!(await file.exists())) return undefined
    try {
      const parsed: unknown = await file.json()
      return isArtifactInfo(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  return createArtifactStore(
    {
      readMeta,
      writeMeta: (info) => writeAtomically(metaPath(info.id), JSON.stringify(info)),
      writeData: (id, data) => writeAtomically(dataPath(id), data),
      async readData(id) {
        const file = Bun.file(dataPath(id))
        return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined
      },
      async streamData(id) {
        const file = Bun.file(dataPath(id))
        return (await file.exists()) ? file.stream() : undefined
      },
      async remove(id) {
        await rm(metaPath(id), { force: true })
        await rm(dataPath(id), { force: true })
      },
      async listMeta() {
        const infos: ArtifactInfo[] = []
        for (const first of await listDir(dir)) {
          if (!/^[0-9a-f]{2}$/.test(first)) continue
          for (const second of await listDir(join(dir, first))) {
            for (const entry of await listDir(join(dir, first, second))) {
              const id = entry.slice(0, -'.json'.length)
              if (!entry.endsWith('.json') || !isArtifactId(id)) continue
              const info = await readMeta(id)
              if (info) infos.push(info)
            }
          }
        }
        return infos
      },
      async ping() {
        await mkdir(dir, { recursive: true })
      },
      async readRef(name) {
        const file = Bun.file(refPath(name))
        if (!(await file.exists())) return undefined
        try {
          const parsed: unknown = await file.json()
          return isArtifactRef(parsed) ? parsed : undefined
        } catch {
          return undefined
        }
      },
      writeRef: (name, ref) => writeAtomically(refPath(name), JSON.stringify(ref)),
      async removeRef(name) {
        await rm(refPath(name), { force: true })
      },
    },
    options,
  )
}

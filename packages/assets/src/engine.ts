import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { defaultIgnore, scanFiles } from './inventory.ts'

const engines: [string, RegExp][] = [
  ['pixi', /^(?:pixi\.js|pixi\.js-legacy|@pixi\/.+)$/],
  ['phaser', /^phaser\d?$/],
  ['three', /^(?:three|@react-three\/fiber)$/],
  ['babylon', /^(?:babylonjs|@babylonjs\/.+)$/],
  ['cocos', /^(?:cocos-creator|cc|@cocos\/.+)$/],
  ['playcanvas', /^(?:playcanvas|@playcanvas\/.+)$/],
]

/** Game engines a package.json depends on, by package name. */
export function enginesOf(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return []
  const fields = new Map<string, unknown>(Object.entries(manifest))
  const names = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => {
    const value = fields.get(field)
    return typeof value === 'object' && value !== null ? Object.keys(value) : []
  })
  const isCocos = 'creator' in manifest
  return engines
    .filter(
      ([engine, pattern]) =>
        names.some((name) => pattern.test(name)) || (engine === 'cocos' && isCocos),
    )
    .map(([engine]) => engine)
}

/** Engines used by any package.json of the repository, sorted. */
export async function detectEngines(dir: string): Promise<string[]> {
  const found = new Set<string>()
  const manifests = await scanFiles(
    dir,
    ['package.json', '*/package.json', '*/*/package.json'],
    defaultIgnore,
  )
  for (const manifest of manifests) {
    try {
      for (const engine of enginesOf(JSON.parse(await readFile(join(dir, manifest), 'utf8')))) {
        found.add(engine)
      }
    } catch {}
  }
  return [...found].toSorted()
}

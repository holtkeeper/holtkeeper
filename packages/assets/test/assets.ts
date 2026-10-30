import type { Asset } from '../src/data.ts'

/** A source PNG asset with overridable fields. */
export const asset = (path: string, overrides: Partial<Asset> = {}): Asset => ({
  path,
  kind: 'image',
  format: path.slice(path.lastIndexOf('.') + 1),
  bytes: 1000,
  hash: `hash-${path}`,
  origin: 'source',
  ...overrides,
})

# @holtkeeper/artifacts

Content-addressed storage for files Holtkeeper generates: image variants, optimized SVGs, archives. An artifact's id is the SHA-256 (lowercase hex) of its content, so the same bytes are stored once and an id always names the same content. Analyses keep their data small by referencing artifacts (`write-binary` edits with `artifact: <id>`, see `@holtkeeper/changes`) instead of embedding base64.

## Store contract

```ts
interface ArtifactStore {
  put(data, { contentType?, name?, tags? }): Promise<{ id, bytes }>
  get(id): Promise<{ data, id, bytes, contentType, name?, createdAt, lastAccessedAt?, tags? } | undefined>
  open(id): Promise<{ info, body: ReadableStream } | undefined> // streams, no buffering
  stat(id) / has(id) / delete(id)
  list({ prefix?, cursor?, limit? }): Promise<{ items, cursor? }> // ordered by id
  usage(): Promise<{ count, bytes, byContentType, byTag }>
  sweep({ olderThan?, maxBytes? }): Promise<{ removed, bytes }>
  presign?(id, { expiresIn?, filename? }): Promise<string | undefined> // S3 only
  getRef(name) / setRef(name, { id, meta? }) / deleteRef(name) // named pointers
}
```

- Malformed ids (anything but 64 hex characters) are treated as unknown, so ids are safe to take from URLs.
- `put` of stored content refreshes its access time and merges metadata: `name` and `contentType` are replaced when given, `tags` merged (later puts win per key). Typical tags: `{ repo: 'work:games/a', kind: 'media', analysis: '<id>' }`.
- `lastAccessedAt` is updated by `put`, `get` and `open`, at most once per `touchIntervalMs` (default one hour) so reads stay cheap. `stat` does not count as an access.
- `sweep` first removes artifacts not accessed since `olderThan`, then the least recently accessed ones until at most `maxBytes` remain.

- Refs are named pointers to artifacts, like git refs, so content can be found by a key the caller computes (`cache/media/v1/<source hash>/<spec hash>`) rather than by its hash. Names are `/`-separated segments of `[A-Za-z0-9._:-]` without `.`/`..`, at most 512 characters; `meta` holds small scalar facts (image width, quality). `setRef` requires the artifact to be stored; `getRef` returns `undefined` once the artifact is gone, so sweeps invalidate refs without touching them. Refs are not artifacts: `list`, `usage` and `sweep` ignore them. Stores keep them at `refs/<name>.json` (memory: a map).

## Cache

`artifactCache(store, { namespace?, tags?, onError? })` → `BlobCache { get(key), set(key, data, { meta?, contentType?, name? }) }`: content is stored as an artifact (tagged `kind: cache` by default), the key becomes the ref `<namespace>/<key>` (default namespace `cache`; keys that are not valid ref names are hashed). Neither method throws — a failing store reads as a miss and the error goes to `onError` — so callers can use it unconditionally. On an S3 store the cache is shared by every process using the bucket. `@holtkeeper/media` (`VariantCache`) and analyzers (`context.cache`, `RunCache`) take this shape.

## Implementations

| Factory                                                                                                                      | Storage                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryArtifactStore()`                                                                                                      | Process memory; tests and short-lived tools.                                                                                                                                                                                                                                                                                 |
| `fsArtifactStore({ dir })`                                                                                                   | `<dir>/ab/cd/<id>` plus a `<id>.json` metadata sidecar. Every write goes to a temporary file renamed into place; the sidecar is written after the data, so a sidecar means a complete artifact.                                                                                                                              |
| `s3ArtifactStore({ bucket, endpoint?, region?, accessKeyId, secretAccessKey, sessionToken?, prefix?, virtualHostedStyle? })` | Any S3-compatible bucket (AWS, Cloudflare R2, Garage, Ceph, MinIO, Versity S3 Gateway) through Bun's built-in `S3Client`. Keys `<prefix>/ab/cd/<id>` and `<id>.json` sidecar objects; `presign` gives short-lived download URLs. `usage` lists the bucket and reads sidecars, so it is cached for a minute (`usageCacheMs`). |

All three are built with `createArtifactStore(backend, { now?, touchIntervalMs?, usageCacheMs? })` on a small `ArtifactBackend` (read/write data and metadata, stream, remove, list metadata, read/write/remove refs, optional presign); a new backend only implements those primitives. `list` and `sweep` walk all metadata, which suits stores up to tens of thousands of artifacts.

## Helpers

- `artifactId(data)`, `isArtifactId(id)`, `isArtifactInfo(value)`, `fanout(id)` (`ab/cd/<id>`), `summarizeUsage(items)`.
- `zipArtifacts([{ path, data }])` builds a ZIP with fflate; images, fonts and archives are stored, everything else deflated. `unzipArtifacts(zip)` reads one back. Both refuse absolute paths, `..` segments and duplicates (`safeArchivePath`).

## Storage overview

`StorageProvider { id, label, usage(): { bytes, count?, details?, available?, note? }, clear?(scope?) }` is the contract behind the server's `GET /api/storage`. `artifactStorage(store)` reports details by content type and by `repo` tag; `clear()` empties the store, `clear('repo=work:games/a')` removes artifacts with that tag value, `clear('olderThanDays=30')` sweeps by age. Other packages provide the same shape: `mirrorStorage` (`@holtkeeper/workspace`) and `miseCacheStorage` (`@holtkeeper/exec-container`).

## Tests

`test/stores.test.ts` runs one contract suite against all three stores; the S3 store talks to `test/fake-s3.ts`, a `Bun.serve` implementing the few S3 calls used (put, get, head, delete, ListObjectsV2) — no cloud access.

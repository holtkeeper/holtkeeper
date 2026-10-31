/** What a store knows about one artifact besides its bytes. Times are ISO 8601. */
export interface ArtifactInfo {
  /** Lowercase hex SHA-256 of the content. */
  id: string
  /** Size of the content. */
  bytes: number
  contentType: string
  /** Suggested file name or repository path, e.g. `img/hero-640w.webp`. */
  name?: string
  createdAt: string
  /** Last `put`, `get` or `open`; updated at most once per `touchIntervalMs` to keep writes rare. */
  lastAccessedAt?: string
  /** Free-form labels, e.g. `{ repo: 'work:games/a', kind: 'media', analysis: '<id>' }`. */
  tags?: Record<string, string>
}

/** An artifact with its content. */
export interface Artifact extends ArtifactInfo {
  data: Uint8Array
}

export interface PutOptions {
  /** Default `application/octet-stream`. */
  contentType?: string
  name?: string
  /** Merged into the tags of an artifact stored before; later puts win per key. */
  tags?: Record<string, string>
}

export interface ListOptions {
  /** Only ids starting with this hex prefix. */
  prefix?: string
  /** `cursor` of the previous page. */
  cursor?: string
  /** Default 100, at most 1000. */
  limit?: number
}

/** One page of `list`, ordered by id; `cursor` is set when more follow. */
export interface ArtifactPage {
  items: ArtifactInfo[]
  cursor?: string
}

export interface UsageBucket {
  count: number
  bytes: number
}

/** Totals of a store; `byTag[key][value]` counts artifacts carrying that tag. */
export interface ArtifactUsage extends UsageBucket {
  byContentType: Record<string, UsageBucket>
  byTag: Record<string, Record<string, UsageBucket>>
}

/**
 * What `sweep` removes: artifacts not accessed since `olderThan`, then the least recently accessed
 * ones until the store holds at most `maxBytes`. Both optional; with neither nothing is removed.
 */
export interface SweepOptions {
  olderThan?: Date
  maxBytes?: number
}

export interface SweepResult {
  removed: number
  bytes: number
}

export interface PresignOptions {
  /** Seconds the URL stays valid. Default 300. */
  expiresIn?: number
  /** File name the browser saves the download as. */
  filename?: string
}

/** Scalar values a ref may carry next to the artifact id. */
export type RefMeta = Record<string, string | number | boolean>

/**
 * A named pointer to an artifact, like a git ref: lets callers find content by a key they can
 * compute (e.g. the inputs of an expensive encode) instead of by its hash.
 */
export interface ArtifactRef {
  /** Artifact the ref points at. */
  id: string
  /** Small facts about the target the caller needs without reading it, e.g. image dimensions. */
  meta?: RefMeta
  updatedAt: string
}

/**
 * Content-addressed blob storage for generated files (image variants, optimized SVGs, archives).
 * The id is the SHA-256 of the content, so storing the same bytes twice keeps one copy and an id
 * always names the same content. Implementations: `memoryArtifactStore`, `fsArtifactStore`,
 * `s3ArtifactStore`.
 */
export interface ArtifactStore {
  /** Stores `data` (or refreshes an existing copy's metadata and access time). */
  put(data: Uint8Array, options?: PutOptions): Promise<{ id: string; bytes: number }>
  /** `undefined` for unknown or malformed ids. */
  get(id: string): Promise<Artifact | undefined>
  /** Metadata and a stream of the content, without buffering it. */
  open(id: string): Promise<{ info: ArtifactInfo; body: ReadableStream<Uint8Array> } | undefined>
  /** Metadata only; does not count as an access. */
  stat(id: string): Promise<ArtifactInfo | undefined>
  has(id: string): Promise<boolean>
  /** `false` when there was nothing to delete. */
  delete(id: string): Promise<boolean>
  list(options?: ListOptions): Promise<ArtifactPage>
  /**
   * Rejects when the backing storage cannot be reached. One cheap request whatever the store
   * holds, unlike `list`, which reads every artifact's metadata; for health checks.
   */
  ping(): Promise<void>
  usage(): Promise<ArtifactUsage>
  sweep(options: SweepOptions): Promise<SweepResult>
  /**
   * A short-lived URL that downloads the artifact directly from the backing service; present only
   * on stores that support it (S3). Resolves `undefined` for unknown ids.
   */
  presign?(id: string, options?: PresignOptions): Promise<string | undefined>
  /**
   * The ref `name` points at; `undefined` when the name is unknown or malformed, or its artifact
   * is gone (deleted or swept). Does not count as an access of the artifact.
   */
  getRef(name: string): Promise<ArtifactRef | undefined>
  /**
   * Points `name` at a stored artifact, replacing any earlier target. Names are `/`-separated
   * segments of letters, digits, `.`, `_`, `-` and `:` (no `..`), at most 512 characters.
   * Throws for a malformed name or an unknown artifact.
   */
  setRef(name: string, ref: { id: string; meta?: RefMeta }): Promise<ArtifactRef>
  /** `false` when there was no such ref. The artifact itself stays. */
  deleteRef(name: string): Promise<boolean>
}

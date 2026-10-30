import type { DiffFile, DiffRefs, GitForge, RepoRef, ReviewComment } from '@holtkeeper/forge'

import { parseHunks } from './diff.ts'
import type { Candidate } from './validate.ts'

/** An image the merge request adds or changes. SVGs carry `text`, raster images `bytes` when readable. */
export interface MediaFile {
  path: string
  status: DiffFile['status']
  bytes?: Uint8Array
  text?: string
}

/** A line the diff adds that references one of the images, e.g. an `<img>` or `import`. */
export interface MediaUsage {
  path: string
  line: number
  text: string
}

export interface MediaReviewInput {
  repo: RepoRef
  mergeRequest: number
  refs: DiffRefs
  files: MediaFile[]
  usages: MediaUsage[]
}

/**
 * Reviews images of a merge request: optimization potential, modern formats, responsive markup.
 * Comments must target new-side diff lines (an SVG line or a usage line); `summary` is Markdown
 * appended to the review summary under an "Images" heading.
 */
export interface MediaReviewer {
  review(input: MediaReviewInput): Promise<{ comments: ReviewComment[]; summary?: string }>
}

/** Reviews nothing; the default until a real reviewer is injected. */
export const noopMediaReviewer: MediaReviewer = {
  review: async () => ({ comments: [] }),
}

const imagePattern = /\.(png|jpe?g|gif|webp|svg)$/i

/** Added, modified or renamed images of the diff. */
export const imageFiles = (files: readonly DiffFile[]) =>
  files.filter((file) => file.status !== 'deleted' && imagePattern.test(file.newPath))

/** Added lines of non-image files that mention an image by file name. */
export function imageUsages(files: readonly DiffFile[], images: readonly DiffFile[]): MediaUsage[] {
  const names = [
    ...new Set(images.map((image) => image.newPath.split('/').at(-1) ?? image.newPath)),
  ]
  if (names.length === 0) return []
  return files.flatMap((file) => {
    if (imagePattern.test(file.newPath) || file.binary) return []
    return parseHunks(file.diff).flatMap((hunk) =>
      hunk.lines.flatMap((line) =>
        line.kind === 'add' && line.newLine && names.some((name) => line.text.includes(name))
          ? [{ path: file.newPath, line: line.newLine, text: line.text }]
          : [],
      ),
    )
  })
}

type ReadBytes = (repo: string, file: string, ref?: string) => Promise<Uint8Array | undefined>

/** `forge.readFileBytes`, an optional method not every forge has yet. */
function readBytesOf(forge: GitForge): ReadBytes | undefined {
  const method: unknown = Reflect.get(forge, 'readFileBytes')
  if (typeof method !== 'function') return undefined
  return async (repo, file, ref) => {
    const value: unknown = await Reflect.apply(method, forge, [repo, file, ref])
    return value instanceof Uint8Array ? value : undefined
  }
}

/**
 * Collects the images and their usages and asks `reviewer` about them. Raster bytes come from
 * `forge.readFileBytes` and are left out when the forge lacks it; SVG text comes from `readFile`.
 * Comments become `minor` `performance` findings. Returns nothing when there are no images.
 */
export async function reviewMedia(options: {
  reviewer: MediaReviewer
  forge: GitForge
  repo: RepoRef
  mergeRequest: number
  refs: DiffRefs
  files: readonly DiffFile[]
}): Promise<{ candidates: Candidate[]; summary?: string } | undefined> {
  const images = imageFiles(options.files)
  if (images.length === 0) return undefined
  const readBytes = readBytesOf(options.forge)
  const head = options.refs.headSha
  const files = await Promise.all(
    images.map(async (image): Promise<MediaFile> => {
      const base = { path: image.newPath, status: image.status }
      if (/\.svg$/i.test(image.newPath)) {
        const text = await options.forge.readFile(options.repo.path, image.newPath, head)
        return text === undefined ? base : { ...base, text }
      }
      const bytes = await readBytes?.(options.repo.path, image.newPath, head)
      return bytes ? { ...base, bytes } : base
    }),
  )
  const result = await options.reviewer.review({
    repo: options.repo,
    mergeRequest: options.mergeRequest,
    refs: options.refs,
    files,
    usages: imageUsages(options.files, images),
  })
  return {
    candidates: result.comments.map((comment) => {
      const [first = 'Image optimization', ...rest] = comment.body.trim().split('\n')
      const title = first.replace(/^#+\s*|\*\*/g, '').trim() || 'Image optimization'
      return {
        path: comment.path,
        line: comment.line,
        ...(comment.startLine ? { startLine: comment.startLine } : {}),
        severity: 'minor' as const,
        category: 'performance' as const,
        title,
        body: rest.join('\n').trim() || comment.body,
        source: 'media',
        ...(comment.suggestion ? { suggestion: comment.suggestion } : {}),
      }
    }),
    ...(result.summary?.trim() ? { summary: result.summary.trim() } : {}),
  }
}

# @holtkeeper/changes

Suggested code changes that people can accept: lint autofixes, renames to the project's conventions, generated tests, dependency bumps. Every analysis that proposes edits uses `CodeChange`, so one UI and one applier serve all of them.

## Model

```ts
interface CodeChange {
  id: string // stable across runs for the same suggestion
  title: string
  description?: string
  confidence: 'safe' | 'review'
  source: string // 'oxlint', 'conventions', 'claude', ...
  edits: Edit[]
}

type Edit =
  | { kind: 'replace'; file; range: { start; end }; oldText; newText } // 1-based line/column, end exclusive
  | { kind: 'create'; file; newText }
  | { kind: 'delete'; file; oldText }
  | { kind: 'write-binary'; file; bytes; base64?; artifact?; previousSha256? }
```

Edits carry the text they expect to replace. Applying a suggestion to a file that changed since the analysis is detected as a conflict instead of corrupting the file.

### Binary files

`write-binary` writes a whole binary file (an optimized image, a generated variant). Its content comes from `base64`, or from an artifact id (`@holtkeeper/artifacts`) resolved through `planChanges(..., { resolveArtifact })`; `bytes` must match the content's size. `previousSha256` is the SHA-256 of the file it replaces: the change conflicts when the current bytes hash differently, and without it the change conflicts when the file already exists. A binary write cannot be combined with other edits of the same file in one change, and later text edits to a file written as binary conflict.

## Applying

| Function                                                              | Does                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planChanges(changes, files, { resolveArtifact? })`                   | Computes new contents through any `FileAccess` (`read(file)`, optional `readBytes(file)` for binaries); applies what applies cleanly, reports the rest as `conflicts`. Nothing is written. Binary results carry `bytes` (and `content: undefined`). |
| `applyToDisk(root, changes, { resolveArtifact? })`                    | Applies to a local checkout, writing binaries byte for byte; refuses paths outside it.                                                                                                                                                              |
| `openMergeRequest({ forge, repo, changes, title, resolveArtifact? })` | Reads current files from the forge (`readFileBytes` for binaries when the forge has it), commits the applicable changes to a new branch in one API commit (binaries as `encoding: 'base64'` actions) and opens a merge request.                     |
| `unifiedDiff(files)`                                                  | A patch for `git apply` from before/after contents. Entries with `bytes` are left out and listed in a trailing `#` comment block.                                                                                                                   |
| `changeDiff(change)`                                                  | Per-file hunks from the change's own snippets, for rendering without repository access. Binary files get status `binary`, no hunks and `binary: { after }` sizes.                                                                                   |

`sha256Hex(bytes)` gives the hash `previousSha256` is compared with.

The server exposes accepting as `POST /api/analyses/:id/changes { ids, mode: 'patch' | 'merge-request' }`.

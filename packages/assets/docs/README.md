# @holtkeeper/assets

Asset budgets for games and frontends: inventories the images, audio, video, fonts, atlases and models a repository ships, reads their headers, checks them against budgets, suggests smaller formats and compares with the previous record.

## Analyzer

`assetsAnalyzer` — kind `assets`, scope `repo`, needs a checkout. Options (`assetsOptionsSchema`):

| Option        | Default                              | Meaning                                                                                                                  |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `roots`       | `defaultRoots`                       | Globs to scan: `public/**`, `assets/**`, `static/**`, `src/**/assets/**`, `res/**`                                       |
| `dist`        | —                                    | Build output folder, scanned as well with `origin: 'build'` (flag `--dist`)                                              |
| `ignore`      | `[]`                                 | Extra globs to skip; `node_modules`, `.git` and dot folders are always skipped                                           |
| `budgets`     | `[]`                                 | `{ pattern, maxBytes?, maxWidth?, maxHeight?, kind? }` per-asset limits                                                  |
| `total`       | `{}`                                 | Maximum bytes per kind, e.g. `{ audio: 5000000 }`                                                                        |
| `convert`     | `sharp` if it loads, else `estimate` | `sharp` (real variants and changes), `estimate` (ratios), `tools` (measure with converters), `off` (flag `--convert`)    |
| `optimizeTop` | `20`                                 | With `sharp`: images (raster and SVG together) optimized, largest first (flag `--optimize-top`)                          |
| `svgPreset`   | `safe`                               | With `sharp`: svgo preset of SVG changes (flag `--svg-preset`)                                                           |
| `naming`      | —                                    | With `sharp`: `{ width?, density? }` variant file templates, default `{name}-{width}w.{ext}` / `{name}@{density}x.{ext}` |

`analyzeAssets(options)` runs the same pipeline without the analyzer wrapper; it never writes to the checkout.

## Pipeline

1. **Inventory** (`inventory`, `scanFiles`) — known formats of any size and unknown binaries from 256 kB (`OTHER_MIN_BYTES`); code, styles and documents are skipped. Each `Asset` has `path`, `kind` (`image`, `audio`, `video`, `font`, `atlas`, `model`, `data`, `other`), `format`, `bytes`, `gzip` (text formats), `hash` (SHA-256 prefix) and `origin`.
2. **Headers** — pure parsers, no native dependencies; malformed files just get no metadata.
   - Images (`image`): PNG/APNG (IHDR, tRNS, acTL), JPEG (SOF), GIF (frames, transparency), WebP (VP8, VP8L, VP8X/ANMF), AVIF (`ispe`, `pixi`, auxiliary alpha, `avis`), SVG (`width`/`height`, `viewBox`), BMP, ICO.
   - Audio (`audio`): WAV (`fmt `/`data`), MP3 (frame header, Xing/Info/VBRI, else CBR), Ogg Vorbis/Opus (headers + last granule), FLAC (STREAMINFO), M4A (`mvhd`, `mp4a`). Video (`video`): MP4 duration and track size.
   - Fonts (`font`): TrueType/OpenType/WOFF glyph count from `maxp`; WOFF2 and collections report the format only.
   - Atlases (`atlas`): TexturePacker / Pixi / Phaser JSON, libGDX/Spine `.atlas`, AngelCode `.fnt` — frame count and texture names.
3. **References** (`collectTokens`, `isReferenced`) — tokens of every source and config file (generated folders skipped) plus atlas/glTF texts. An asset is referenced when its file name, a path suffix, or its stem (3+ chars, e.g. loader keys) appears. Favicons and similar are implicit. Build outputs are not checked.
4. **Engines** (`detectEngines`) — pixi, phaser, three, babylon, cocos, playcanvas from `package.json` files up to two levels deep.
5. **Checks** — `evaluateBudgets` (per-asset and per-kind total), `findIssues` (`huge-dimensions` above 4096 px, `non-power-of-two` for raster images ≥ 64 px when an engine is found, `unused`), `findDuplicates` (by hash within an origin).
6. **Suggestions** (`candidates`, `estimateSuggestions`, `measureSuggestions`) — opaque PNG → WebP lossy, PNG with alpha → WebP lossless, JPEG → AVIF, animated GIF → animated WebP, WAV/FLAC → Ogg Vorbis, TTF/OTF → WOFF2. `estimateRatios` holds the conservative ratios with their sources. `convert: 'tools'` copies each candidate to a temp dir and runs `cwebp`, `avifenc`, `ffmpeg` or `woff2_compress` through the `CommandRunner`; a missing tool or failed conversion falls back to the estimate. Assets under 8 kB and savings under 2 kB are dropped.

7. **Optimization** (`convert: 'sharp'`, `optimizationCandidates`, `optimizeAssets`) — the `optimizeTop` largest source images: PNG/APNG/JPEG/GIF/WebP from `minBytes` (8 kB) and SVGs from 512 bytes. Built on `@holtkeeper/media`:
   - Usages (`usageSources`, `findReferences`, `imgReferences`, `cssReferences`, `resolveImage`): `<img src="…">` with a literal src in `.html/.htm/.jsx/.tsx/.vue` and `background`/`background-image: url(…)` in `.css/.scss/.less`. `/x.png` resolves against `public/`, `static/` and the root, relative URLs against the file, `@/`/`~/` against `src/`. Tags with `srcset`, inside `<picture>`, with dynamic src, and declarations already using `image-set()` are left alone.
   - Usage kind (`usageOf`): `fixed` when every `<img>` gives the same `width` (density ladder), `texture` in game projects (an engine found) without markup usages, otherwise `responsive`.
   - Rasters are probed, planned and encoded with sharp; a format is proposed when its full-size variant saves at least `minSaving` (2 kB) (`proposedVariants`). The change (`assets:image:<path>`) has `write-binary` edits for the proposed variants — `artifact` is the variant SHA-256, no base64; the full-size re-encode in the original format overwrites the original with `previousSha256` — plus, when usages were found, `replace` edits swapping each `<img>` for a `<picture>` snippet (React/Vue/HTML by file type, keeping other attributes such as `className`) and each CSS declaration for itself plus an `image-set()` declaration. Confidence `review` with swaps or a lossy overwrite of the original, `safe` otherwise.
   - SVGs are optimized with svgo; a saving of at least 2% (min 64 bytes, at most `minSaving`) becomes a whole-file `replace` change (`assets:svg:<path>`), `safe` for the `safe` preset and `review` otherwise. SVGs over 512 kB are reported but get no change.
   - Measured results replace the estimated image suggestions (`method: 'measured'`, SVGs as rule `svg`); `tools` lists `sharp` and `svgo` when they measured something. Undecodable images are kept with `error`.

### Artifacts contract

Analysis data stays JSON-serializable: variants are stored as sizes and hashes only. The encoded bytes of every proposed variant are kept in memory for the returned data object: `collectArtifacts(data)` → `{ sha256, bytes, data }[]`, one per distinct `artifact` of the `write-binary` edits. It works only on the exact object `analyzeAssets` (or `assetsAnalyzer.run`) returned, in the same process — a copy, a parsed record or a run without `sharp` yields `[]`. `assetsAnalyzer.run` returns them as analyzer `artifacts` (`runArtifacts(data)`: `id` = sha256, `contentType`, `name` = target path), which the job engine and `holtkeeper analyze assets --upload` store tagged with the analysis, so the changes can be applied later.

Build files with the same hash as a source file are the same shipped asset: they count once in totals, get no suggestion and are not duplicates.

## Data

`AssetsData { roots, engines, convert, tools, assets, totals, budgets, findings, suggestions, duplicates, optimized?, svgs?, changes? }`, validated by `assetsDataSchema`.

- `optimized`: `ImageOptimization { path, format, bytes, width, height, usage, variants, skipped, best?, references, changeId?, error? }`; each `ImageVariant { id, format, width, height, density?, bytes, quality, ssim?, sha256, file, replacesOriginal?, proposed }`.
- `svgs`: `SvgOptimizationData { path, preset, bytes, gzip, breakdown, changeId?, error? }` — the svgo breakdown without the optimized text, which lives in the change.
- `changes`: `CodeChange[]`, also returned by `assetsAnalysis.changes(data)`.

## Comparison and report

`compareAssets(previous, current)` matches assets by path; an unmatched new path with the hash of a removed one is `renamed`. It returns per-kind totals, asset changes (`added`, `removed`, `grown`, `shrunk`, `changed`, `renamed`) and new/resolved budget violation ids.

`assetsAnalysis` (or `createAssetsAnalysis({ largest, treemapFiles, imageCards })`) reports:

- Metrics: total bytes, bytes per kind, over-budget count, proposed changes (when there are changes), potential savings — each with a delta against the previous record.
- Overview: bytes by kind chart, folder → file treemap.
- Budgets: violations (new ones tagged), resolved ones, huge and non-power-of-two textures.
- Suggestions: asset, current, suggested format, how, expected size, saving, estimated/measured; possibly unused assets.
- Image optimization (with `sharp`): per image original, full-size AVIF/WebP/re-encoded sizes, best saving, Δ of the best size against the previous record, proposed/total variants and usages; per-image cards (`imageCards`, default 10) with every format's widths or densities, full-size and smallest bytes, saving, quality and status; images that could not be decoded; an applicable `changes` block with the variants and image swaps (binary files listed without hunks).
- SVG optimization: before/after bytes and gzip, saving, Δ against the previous record, what was removed; path data (paths, commands, coordinates, digits, longest path before → after); viewBox/size/embedded-raster issues; an applicable `changes` block.
- Largest assets: size, gzip, dimensions/duration/glyphs, tags.
- Changes since previous: per kind and per asset (only with a previous record).
- Duplicates: copies and wasted bytes.

## Limitations

- Default roots are relative to the repository root; monorepos with `apps/*/public` need `roots`.
- WebM, AAC (ADTS) and KTX/Basis textures are inventoried without metadata.
- Reference search is token based: assets loaded by computed names look unused.
- Usage rewriting is regex based: `<img>` attributes with nested braces, `<Image>` components and imported image modules (`src={hero}`) are not rewritten; variants are written next to the original, so URLs keep the original folder.
- `sharp` mode encodes up to `optimizeTop` images with every ladder width and format; large images take seconds each.

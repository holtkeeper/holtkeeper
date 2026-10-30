# @holtkeeper/media

Image and SVG optimization engine: plans and encodes responsive raster variants with [sharp](https://sharp.pixelplumbing.com/), optimizes SVGs with [svgo](https://svgo.dev/), writes the markup that uses the variants and summarizes the savings. It works on buffers and strings only — no file system, no network — so callers (like `@holtkeeper/assets`) decide what to read and where results go.

sharp is loaded lazily (`loadSharp`, `sharpAvailable`, `requireSharp`): importing this package never fails on machines without the native binary; only encoding does.

## Raster variants

```ts
const info = await probeImage(bytes) // { format, width, height, alpha, animated, frames?, content, colors?, wideGamut? }
const plan = planVariants(info, { usage: 'responsive' })
const { variants, failures } = await encodeVariants(bytes, plan.specs, {
  info,
  concurrency: 2,
  signal,
})
```

- `probeImage` — dimensions after EXIF orientation, alpha only when some pixel is not opaque, `animated`/`frames`, `content: 'graphic'` for flat art (≤ 256 exact colors, or few colors in a 64×64 sample), exact `colors` when ≤ 256, `wideGamut` for a non-sRGB ICC profile.
- `planVariants(info, options)` → `{ usage, specs, skipped }`:
  - Formats: `avif`, `webp` and the source format re-encoded (`originalOutput`: PNG stays PNG, JPEG via mozjpeg, unknown formats become PNG or JPEG). JPEG is skipped for alpha, AVIF/PNG/JPEG for animated sources (sharp animates only WebP and GIF), GIF for stills — each with a `reason`.
  - Sizes: `responsive` uses `defaultWidths` (320, 640, 960, 1280, 1920, 2560) below the source width plus the source width itself (only for the source format when the source is wider than the ladder); `fixed` (`displayWidth`) uses `@1x/@2x/@3x` and never upscales; `texture` treats the source as the highest density (`[1, 2]` by default) and scales down.
  - Settings: `defaultQuality` (AVIF 55, WebP 78, JPEG 78); AVIF 4:4:4 for alpha and graphics (alpha at least q70), WebP `alphaQuality: 100` for alpha, lossless WebP for ≤ 256 colors and near-lossless for other graphics, palette PNG only when it is lossless, otherwise PNG level 9. The re-encode of the source format at full size has `replacesOriginal` (never for textures, whose files keep `@Nx` names).
  - `targetSsim` (e.g. `0.985`) marks lossy specs for a quality search between `quality − 30` and `quality`.
- `encodeVariants(input, specs, options)` → `{ variants, failures }`. Every `EncodedVariant` has `spec`, `bytes`, `width`, `height`, `format`, `quality`, `ssim?`, `data` and `sha256`. EXIF orientation is applied, metadata is stripped, the ICC profile is kept only when it is not sRGB. A `targetSsim` spec binary-searches its quality with at most six encodes, scoring `ssim` (8×8-window SSIM on luma downscaled to 256 px, flattened on white) against the source resized to the same size; when no quality reaches the target the spec's own quality is used. A failing spec lands in `failures`; an aborted `signal` throws.
- `ssim(a, b, width, height)` — the metric, on 8-bit single-channel buffers.

## SVG

`optimizeSvg(text, { preset, precision, multipass, keepIds })` → `{ text, preset, bytes: { before, after }, gzip: { before, after }, breakdown }`.

| Preset       | What it does                                                                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safe`       | preset-default without anything CSS or scripts could depend on: IDs, `<style>` rules and classes, inline `style`, hidden elements, `<desc>`, shapes (no shape→path), groups, data/aria/role attributes are kept. Removes prolog, comments, metadata, editor namespaces; shortens numbers. |
| `default`    | svgo preset-default plus `convertStyleToAttrs`; unreferenced IDs are removed and the rest minified, except `keepIds`.                                                                                                                                                                     |
| `aggressive` | `default` plus `removeXlink`, `reusePaths`, `removeOffCanvasPaths`, precision 2.                                                                                                                                                                                                          |

Precision defaults to 3 decimals. `viewBox` is never removed: svgo v4 keeps it, and if a plugin still drops it, it is restored and reported.

`breakdown` (`SvgBreakdown`): `removedElements` and `removedAttributes` (name → count), `metadata` (metadata elements, editor-namespaced elements, `<?xml?>`, doctype), `comments`, `paths.before/after` (`PathStats`: paths, commands, coordinates, digits, three longest `d` with their ids), `styles` (inline `style` attributes and `<style>` elements before/after), `ids` (before, after, minified) and `issues` (`missing-viewbox`, `size-without-viewbox`, `aspect-mismatch`, `embedded-raster`, `viewbox-restored`). `scanTags` and `pathStats` are the underlying scanners.

## Snippets

`pictureSnippets({ file, variants, framework, alt?, sizes?, width?, height?, naming?, attributes?, indent?, key? })` → `{ framework, language, code, notes }`. `file` is the original as the markup references it; variant URLs come from `variantFile(file, variant, naming)` — next to it, `{name}-{width}w.{ext}` or `{name}@{density}x.{ext}` by default, the original extension for the original format (`.jpg`), the original name for `replacesOriginal`, or the variant's own `url` when set.

| Framework                 | Output                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `html`                    | `<picture>` with AVIF/WebP `<source type srcset sizes>` and `<img src srcset sizes width height alt loading="lazy" decoding="async">`; density variants use `1x`/`2x` descriptors and no sizes |
| `react`                   | the same in JSX: `srcSet`, `width={…}`, self-closing tags                                                                                                                                      |
| `vue`                     | HTML attributes with self-closing tags                                                                                                                                                         |
| `css`                     | `background-image: url(original)` fallback plus `image-set(url() type())` (`imageSetValue` alone)                                                                                              |
| `next`, `nuxt`, `vite`    | `next/image`, `<NuxtPicture format="avif,webp">`, vite-imagetools imports — with notes that these generate variants themselves                                                                 |
| `pixi`, `phaser`, `three` | texture loading with a format fallback and resolution chosen from `devicePixelRatio` (Pixi `@{1,2}x.{webp,png}` patterns, Phaser `device.features.webp`, three `createImageBitmap` probes)     |

Game engine snippets carry a KTX2/Basis Universal note: GPU memory, not download size, limits big textures.

## Savings

`savingsSummary(original, variants, usage?)` → `{ original, formats, best, viewports }`: per format the largest variant's bytes, saving and percent; per viewport (default 375, 768, 1440 CSS px at DPR 2, or `displayWidth`/`fraction`) the smallest variant at least as wide as the needed device pixels (density variants: the smallest density ≥ DPR), as `srcset` picks it. `savingsMarkdown(summary, title?)` renders both as Markdown tables for merge request comments.

## Changes

- `codeChangeSchema`, `editSchema` — zod validation of `CodeChange` including `write-binary` edits.
- `replaceFile(file, oldText, newText)` — a whole-file `replace` edit; `rangeOf`, `positionAt` — 1-based ranges from offsets.
- `changeItem(change, { tone?, tags? })` — a report `changes` item: text edits diffed with `changeDiff`, binary writes as files without hunks (`added`, or `modified` when `previousSha256` is set).
- `Artifact` — `{ sha256, bytes, data }`, the bytes behind a `write-binary` edit's `artifact`.

## Limitations

- Animated sources are re-encoded at their own size only; animated AVIF and APNG output are not supported by sharp.
- SSIM is a cheap luma-only proxy; it ignores chroma and alpha.
- `scanTags` is a regex scanner meant for statistics, not a full XML parser.

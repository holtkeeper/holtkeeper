import { totalsOf } from './budgets.ts'
import {
  type Asset,
  type AssetKind,
  type AssetsPolicy,
  type PolicyViolation,
  assetsPolicySchema,
} from './data.ts'
import { imageFamilies } from './families.ts'
import { extensionOf, formats } from './formats.ts'

/** Setting key of the asset policy. */
export const assetsPolicyKey = 'assets.policy'

/** The policy that applies when no `assets.policy` entry covers a repository. */
export const defaultAssetsPolicy: AssetsPolicy = assetsPolicySchema.parse({})

/** A stored `assets.policy` value as a full policy; invalid or missing values give the default. */
export function parseAssetsPolicy(value: unknown): AssetsPolicy {
  const parsed = assetsPolicySchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : defaultAssetsPolicy
}

const help = `What assets a repository may ship. The assets analysis checks every file against it, reviews flag new files that break it and agents read it through the MCP tool \`asset_policy\`.

- **formats.raster**: the modern format every PNG, JPEG and GIF from 8 kB needs next to it (\`webp\` by default), or \`keep\`.
- **formats.allowed**: when set, files of other extensions are errors.
- **maxBytes**: a file above \`warn\` is a warning, above \`error\` an error; \`perKind\` replaces both for one kind.
- **maxDimension**: raster images and videos wider or taller are warnings.
- **minSaving**: conversions saving less than \`pct\` percent and \`bytes\` are not suggested.
- **ignore**: globs left out of everything; vendored and minified files by default.
- **budgets**: total bytes of all assets, or of one kind.
- The most specific scope wins as a whole: a repository entry replaces its group's.
- Prose rules ("hero images go through our Picture component") belong in the Guide's Assets section.`

/** The `assets.policy` setting for the settings registry. */
export const assetsPolicySetting = {
  key: assetsPolicyKey,
  label: 'Asset policy',
  description:
    'Formats, size and dimension limits, ignored files and budgets assets are checked against.',
  section: 'Repositories',
  default: defaultAssetsPolicy,
  schema: assetsPolicySchema,
  help,
  presets: [
    {
      id: 'web',
      label: 'Web app',
      description: 'WebP next to every raster, 500 kB warning, 1 MB error, 2560 px.',
      value: { formats: { raster: 'webp' }, maxBytes: { warn: 500_000, error: 1_000_000 } },
    },
    {
      id: 'game',
      label: 'Game',
      description: 'Keep raster formats for textures, larger limits for audio and atlases.',
      value: {
        formats: { raster: 'keep' },
        maxBytes: { warn: 1_000_000, error: 4_000_000, perKind: { audio: { error: 8_000_000 } } },
        maxDimension: 4096,
      },
    },
  ],
}

const normalize = (format: string) => (format === 'jpg' ? 'jpeg' : format.toLowerCase())

const legacyRasters = new Set(['png', 'apng', 'jpeg', 'gif'])

/** Smallest legacy raster the policy asks a modern format for. */
const MODERN_FORMAT_MIN_BYTES = 8 * 1024

/** The modern formats `raster` asks for. */
export const requiredFormats = (raster: AssetsPolicy['formats']['raster']): string[] =>
  raster === 'keep' ? [] : raster === 'avif+webp' ? ['avif', 'webp'] : [raster]

/** Whether `path` matches one of the policy's ignore globs. */
export function isIgnored(path: string, policy: Pick<AssetsPolicy, 'ignore'>): boolean {
  return policy.ignore.some((pattern) => new Bun.Glob(pattern).match(path))
}

/** The warn and error bytes that apply to files of `kind`. */
export function byteLimits(policy: AssetsPolicy, kind: AssetKind): { warn: number; error: number } {
  const own = policy.maxBytes.perKind?.[kind]
  return { warn: own?.warn ?? policy.maxBytes.warn, error: own?.error ?? policy.maxBytes.error }
}

/** Kind of a file by its extension; `other` for unknown extensions. */
export const kindOfPath = (path: string): AssetKind => formats[extensionOf(path)]?.kind ?? 'other'

/** Whether the policy allows the extension of `format` at all. */
export function formatAllowed(policy: AssetsPolicy, format: string): boolean {
  const allowed = policy.formats.allowed
  if (!allowed?.length) return true
  return allowed.map(normalize).includes(normalize(format))
}

const kb = (value: number) =>
  value >= 1_000_000 ? `${Math.round(value / 100_000) / 10} MB` : `${Math.round(value / 1000)} kB`

/**
 * Every file, kind and total of `assets` that breaks `policy`, errors first, then by path. Files
 * the policy ignores are skipped; build files identical to a source file are checked once.
 */
export function policyViolations(
  assets: readonly Asset[],
  policy: AssetsPolicy,
): PolicyViolation[] {
  const sourceHashes = new Set(
    assets.filter((asset) => asset.origin === 'source').map((asset) => asset.hash),
  )
  const checked = assets.filter(
    (asset) =>
      !isIgnored(asset.path, policy) && !(asset.origin === 'build' && sourceHashes.has(asset.hash)),
  )
  const violations: PolicyViolation[] = []
  for (const asset of checked) {
    const base = { path: asset.path, kind: asset.kind, format: asset.format }
    if (!formatAllowed(policy, asset.format))
      violations.push({
        ...base,
        id: `format:${asset.path}`,
        rule: 'format',
        severity: 'error',
        message: `.${asset.format} is not an allowed format (${policy.formats.allowed?.join(', ')})`,
      })
    const limits = byteLimits(policy, asset.kind)
    const over = asset.bytes > limits.error ? 'error' : asset.bytes > limits.warn ? 'warn' : ''
    if (over)
      violations.push({
        ...base,
        id: `max-bytes:${asset.path}`,
        rule: 'max-bytes',
        severity: over === 'error' ? 'error' : 'warning',
        actual: asset.bytes,
        limit: limits[over],
        message: `${kb(asset.bytes)} is above the ${over === 'error' ? 'error' : 'warning'} limit of ${kb(limits[over])}`,
      })
    const size = asset.format === 'svg' ? undefined : (asset.image ?? asset.video)
    const side = Math.max(size?.width ?? 0, size?.height ?? 0)
    if (side > policy.maxDimension)
      violations.push({
        ...base,
        id: `max-dimension:${asset.path}`,
        rule: 'max-dimension',
        severity: 'warning',
        actual: side,
        limit: policy.maxDimension,
        message: `${size?.width}×${size?.height} px is larger than ${policy.maxDimension} px`,
      })
  }
  const required = requiredFormats(policy.formats.raster)
  if (required.length)
    for (const family of imageFamilies(checked)) {
      const { original } = family
      if (original.origin !== 'source' || !legacyRasters.has(normalize(original.format))) continue
      if (original.bytes < MODERN_FORMAT_MIN_BYTES) continue
      const missing = required.filter((format) => !family.formats.has(format))
      if (!missing.length) continue
      violations.push({
        id: `modern-format:${original.path}`,
        rule: 'modern-format',
        severity: 'warning',
        path: original.path,
        kind: original.kind,
        format: original.format,
        actual: original.bytes,
        message: `no ${missing.map((format) => format.toUpperCase()).join(' or ')} version next to it`,
      })
    }
  const totals = totalsOf(checked)
  const all = totals.reduce((sum, total) => sum + total.bytes, 0)
  const { total, perKind } = policy.budgets
  if (total !== undefined && all > total)
    violations.push({
      id: 'budget:total',
      rule: 'budget',
      severity: 'error',
      actual: all,
      limit: total,
      message: `all assets together are ${kb(all)}, above the budget of ${kb(total)}`,
    })
  for (const kindTotal of totals) {
    const max = perKind?.[kindTotal.kind]
    if (max === undefined || kindTotal.bytes <= max) continue
    violations.push({
      id: `budget:${kindTotal.kind}`,
      rule: 'budget',
      severity: 'error',
      kind: kindTotal.kind,
      actual: kindTotal.bytes,
      limit: max,
      message: `${kindTotal.kind} files together are ${kb(kindTotal.bytes)}, above the budget of ${kb(max)}`,
    })
  }
  return violations.toSorted(
    (a, b) =>
      Number(a.severity === 'warning') - Number(b.severity === 'warning') ||
      (a.path ?? '').localeCompare(b.path ?? '') ||
      a.id.localeCompare(b.id),
  )
}

/** Whether a saving clears the policy's `minSaving`: at least both its percent and its bytes. */
export function worthSaving(policy: AssetsPolicy, original: number, saving: number): boolean {
  if (saving < policy.minSaving.bytes) return false
  return original > 0 && (saving / original) * 100 >= policy.minSaving.pct
}

/** The policy as plain facts, one Markdown bullet per line, for prompts and the Guide. */
export function assetsPolicyFacts(policy: AssetsPolicy): string {
  const required = requiredFormats(policy.formats.raster)
  const perKind = Object.entries(policy.maxBytes.perKind ?? {}).flatMap(([kind, limits]) =>
    limits
      ? [
          `${kind} ${[limits.warn && `warn ${kb(limits.warn)}`, limits.error && `error ${kb(limits.error)}`].filter(Boolean).join(', ')}`,
        ]
      : [],
  )
  const budgets = [
    policy.budgets.total && `all assets ${kb(policy.budgets.total)}`,
    ...Object.entries(policy.budgets.perKind ?? {}).map(([kind, max]) => `${kind} ${kb(max)}`),
  ].filter(Boolean)
  return [
    required.length
      ? `PNG, JPEG and GIF images from 8 kB ship with a ${required.map((format) => format.toUpperCase()).join(' and ')} version.`
      : 'Raster images keep their formats; no modern format is required.',
    policy.formats.svg === 'optimize'
      ? 'SVG files and inline SVGs are optimized with svgo.'
      : 'SVGs are left as they are.',
    policy.formats.allowed?.length &&
      `Only these file formats are allowed: ${policy.formats.allowed.join(', ')}.`,
    `A file above ${kb(policy.maxBytes.warn)} is a warning, above ${kb(policy.maxBytes.error)} an error.`,
    perKind.length && `Limits per kind: ${perKind.join('; ')}.`,
    `Images and videos are at most ${policy.maxDimension} px wide or tall.`,
    budgets.length && `Budgets: ${budgets.join(', ')}.`,
    policy.ignore.length &&
      `Not checked: ${policy.ignore.map((pattern) => `\`${pattern}\``).join(', ')}.`,
  ]
    .filter((fact): fact is string => typeof fact === 'string' && fact.length > 0)
    .map((fact) => `- ${fact}`)
    .join('\n')
}

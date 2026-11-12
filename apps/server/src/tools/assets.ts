import type { RepoTarget, Scope } from '@holtkeeper/access'
import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import type { AssetsPolicySource, RepoAssetsView } from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/api'
import {
  type AssetsPolicy,
  assetsPolicyFacts,
  byteLimits,
  formatAllowed,
  isIgnored,
  kindOfPath,
  requiredFormats,
} from '@holtkeeper/assets'
import type { RepoRef } from '@holtkeeper/forge'
import type { Store } from '@holtkeeper/store'
import { z } from 'zod'

import { assetsPolicyFor, assetsPolicySource, repoAssetsView } from '../assets.ts'

/** What the `assets` tools read for one caller. */
export interface AssetToolsAccess {
  /** The effective policy of a `forge:path` the caller may read, with its source; `undefined` otherwise. */
  policy: (
    repo: string,
  ) => Promise<{ policy: AssetsPolicy; source: AssetsPolicySource } | undefined>
  /** The Assets view of a `forge:path` the caller may read; `undefined` otherwise. */
  assets: (repo: string) => Promise<RepoAssetsView | undefined>
  /** How a group key is named in tool output; default the key itself. */
  groupLabel?: (key: string) => string
}

/**
 * `AssetToolsAccess` over stored settings and records: a repository is served when `canRead`
 * allows its target (with config groups from `targetOf`); the policy's entry is named only when
 * `canReadScope` allows its scope.
 */
export function storedAssetTools(
  store: Pick<Store, 'settings' | 'analyses'>,
  access: {
    targetOf: (repo: RepoRef) => RepoTarget
    canRead: (target: RepoTarget) => boolean
    canReadScope: (scope: Scope) => boolean
    groupLabel?: (key: string) => string
  },
): AssetToolsAccess {
  const readable = (value: string) => {
    const ref = parseRepo(value)
    if (!ref) return undefined
    const target = access.targetOf(ref)
    return access.canRead(target) ? { ref, target } : undefined
  }
  return {
    policy: async (value) => {
      const found = readable(value)
      if (!found) return undefined
      const effective = await assetsPolicyFor(store, found.target)
      return {
        policy: effective.policy,
        source: assetsPolicySource(effective, access.canReadScope),
      }
    },
    assets: async (value) => {
      const found = readable(value)
      return found && repoAssetsView(store, found.ref, found.target, access.canReadScope)
    },
    ...(access.groupLabel && { groupLabel: access.groupLabel }),
  }
}

const parseRepo = (value: string): RepoRef | undefined => {
  const separator = value.indexOf(':')
  if (separator < 1 || separator === value.length - 1) return undefined
  return { forge: value.slice(0, separator), path: value.slice(separator + 1) }
}

const fromText = (source: AssetsPolicySource, label: (key: string) => string) => {
  if (source.level === 'default') return 'the default policy (nothing set)'
  if (source.level === 'all') return 'the entry for every repository'
  if (source.level === 'repo') return `the repository's own entry`
  const groups = source.entry?.scope.groups
  return groups?.length
    ? `the entry of group ${groups.map((group) => (typeof group === 'string' ? label(group) : group.map(label).join(' & '))).join(', ')}`
    : 'an inherited group entry'
}

/** What the policy says about one file path: ignored, allowed, limits and siblings it needs. */
export function pathFacts(path: string, policy: AssetsPolicy): string[] {
  if (isIgnored(path, policy)) return [`\`${path}\` is ignored: no limit or check applies.`]
  const kind = kindOfPath(path)
  const format = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const limits = byteLimits(policy, kind)
  const required = requiredFormats(policy.formats.raster)
  return [
    `\`${path}\` is a ${kind} file.`,
    formatAllowed(policy, format)
      ? `.${format} is allowed.`
      : `.${format} is not allowed; use one of ${policy.formats.allowed?.join(', ')}.`,
    `Warning above ${formatBytes(limits.warn)}, error above ${formatBytes(limits.error)}.`,
    ...(kind === 'image' && format !== 'svg'
      ? [`At most ${policy.maxDimension} px wide or tall.`]
      : []),
    ...(['png', 'jpg', 'jpeg', 'gif'].includes(format) && required.length
      ? [
          `From 8 kB it needs ${required.map((f) => f.toUpperCase()).join(' and ')} next to it (same name, other extension).`,
        ]
      : []),
    ...(format === 'svg' && policy.formats.svg === 'optimize'
      ? ['Run it through svgo before committing.']
      : []),
  ]
}

const MAX_ROWS = 30

/** Markdown of a repository's newest assets record: totals, budgets and offending files. */
function renderRepoAssets(
  repo: string,
  view: RepoAssetsView,
  severity: 'error' | 'warning' | 'all',
): string {
  const { summary } = view
  if (!summary)
    return `No assets analysis of ${repo} yet; asset_policy still tells what the policy expects.`
  const lines = [
    `# Assets of \`${repo}\`: ${summary.files} files, ${formatBytes(summary.totalBytes)}${view.createdAt ? `, checked ${view.createdAt.slice(0, 10)}` : ''}${view.ref ? ` on ${view.ref}` : ''}`,
    `By kind: ${summary.totals.map((total) => `${total.kind} ${formatBytes(total.bytes)} (${total.count})`).join(', ')}`,
    view.checkedPolicy
      ? `Policy: ${summary.errors} errors, ${summary.warnings} warnings.`
      : 'This record predates the asset policy; only savings and duplicates are known.',
  ]
  if (summary.savings) lines.push(`Possible savings: ${formatBytes(summary.savings)}.`)
  for (const budget of summary.budgets) lines.push(`- Budget: ${budget.message}`)
  const rows = summary.rows.filter((row) =>
    severity === 'all'
      ? true
      : severity === 'error'
        ? row.severity === 'error'
        : row.severity !== 'info',
  )
  if (!rows.length) {
    lines.push('', severity === 'all' ? 'Nothing to act on.' : `No file at ${severity} level.`)
    return lines.join('\n')
  }
  lines.push('', '## Files')
  for (const row of rows.slice(0, MAX_ROWS)) {
    const size = row.width && row.height ? `, ${row.width}×${row.height}` : ''
    const suggestion = row.suggestion
      ? `; ${row.suggestion.how} → ${formatBytes(row.suggestion.expectedBytes)} (saves ${formatBytes(row.suggestion.saving)}, ${row.suggestion.method})`
      : ''
    lines.push(
      `- [${row.severity}] \`${row.path}\` ${formatBytes(row.bytes)}${size}: ${row.problems.map((problem) => problem.message).join('; ')}${suggestion}`,
    )
  }
  const left = rows.length - Math.min(rows.length, MAX_ROWS) + summary.more
  if (left > 0) lines.push(`…and ${left} more files.`)
  return lines.join('\n')
}

/**
 * The read-only `assets` toolset: `asset_policy` (the effective asset policy of a repository,
 * optionally for one path) and `repo_assets` (files of a repository breaking the policy or worth
 * optimizing, from its newest assets analysis). Limited to what `access` serves; never runs an
 * analysis or an LLM.
 */
export function assetsToolset(access: AssetToolsAccess): RegistryToolset {
  return {
    name: 'assets',
    instructions: [
      'Before adding or changing images, fonts, audio or video in a repository, call asset_policy',
      'for the formats, size and dimension limits it allows; repo_assets lists files of a repository',
      'that break the policy or could be smaller.',
    ].join(' '),
    tools: [
      defineTool({
        name: 'asset_policy',
        description:
          'The effective asset policy of a repository: required modern formats, allowed formats, size limits per kind, dimension limit, ignored globs and budgets. With `path`, what applies to that one file.',
        input: z.object({
          repo: z.string().min(1).describe('Repository as forge:path'),
          path: z.string().min(1).optional().describe('Repository-relative file path'),
        }),
        run: async ({ repo, path }) => {
          const effective = await access.policy(repo)
          if (!effective) throw new ToolError(`No repository ${repo} you can read.`)
          const lines = [
            `# Asset policy of \`${repo}\`, from ${fromText(effective.source, access.groupLabel ?? ((key) => key))}`,
            assetsPolicyFacts(effective.policy),
            ...(path
              ? [
                  '',
                  '## This file',
                  ...pathFacts(path, effective.policy).map((fact) => `- ${fact}`),
                ]
              : []),
            '',
            "Prose rules (components to use, where files go) are in repo_rules' assets section.",
          ]
          return lines.join('\n')
        },
        subject: ({ repo, path }) => (path ? `${repo} ${path}` : repo),
      }),
      defineTool({
        name: 'repo_assets',
        description:
          'Files of a repository that break its asset policy or could be smaller, from the newest assets analysis: size, format, problems and the best conversion with expected savings; plus totals per kind and budgets.',
        input: z.object({
          repo: z.string().min(1).describe('Repository as forge:path'),
          severity: z
            .enum(['error', 'warning', 'all'])
            .default('warning')
            .describe(
              'error: only errors; warning: errors and warnings (default); all: also savings and duplicates',
            ),
        }),
        run: async ({ repo, severity }) => {
          const view = await access.assets(repo)
          if (!view) throw new ToolError(`No repository ${repo} you can read.`)
          return renderRepoAssets(repo, view, severity)
        },
        subject: ({ repo }) => repo,
      }),
    ],
  }
}

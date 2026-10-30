import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Cell, Issue, Metric, Report, Section } from '@holtkeeper/report'

import { type UsagesData, importPath, usagesDataSchema } from './model.ts'

const limits = { packages: 300, exports: 60 }

function totals(data: UsagesData) {
  let exports = 0
  let sites = 0
  let typed = 0
  for (const pkg of data.packages) {
    exports += pkg.exports.length
    sites += pkg.count
  }
  typed = data.types.sites ?? 0
  return { packages: data.packages.length, exports, sites, typed }
}

function metrics(data: UsagesData, previous?: UsagesData): Metric[] {
  const now = totals(data)
  const before = previous ? totals(previous) : undefined
  return [
    metric('packages', 'Packages used', now.packages, { previous: before?.packages }),
    metric('exports', 'Exports used', now.exports, { previous: before?.exports }),
    metric('uses', 'Uses', now.sites, { previous: before?.sites }),
    metric('files', 'Files read', data.files, { previous: previous?.files }),
    ...(data.types.status === 'used'
      ? [
          metric('typed', 'Found by types', now.typed, {
            previous: before?.typed,
            hint: 'Uses the TypeScript checker found beyond what imports show',
          }),
        ]
      : []),
  ]
}

function packagesSection(data: UsagesData): Section {
  const rows: Record<string, Cell>[] = data.packages.slice(0, limits.packages).map((pkg) => ({
    name: pkg.name,
    versions: pkg.versions.join(', ') || pkg.ranges.join(', '),
    workspaces: pkg.workspaces.join(', '),
    exports: pkg.exports.length,
    uses: pkg.count,
    files: pkg.files,
    top: pkg.exports
      .slice(0, 5)
      .map((item) => item.name)
      .join(', '),
  }))
  return {
    id: 'packages',
    title: 'Packages',
    blocks: rows.length
      ? [
          {
            type: 'table',
            columns: [
              { key: 'name', label: 'Package', format: 'code' },
              { key: 'versions', label: 'Version' },
              { key: 'workspaces', label: 'Used in' },
              { key: 'exports', label: 'Exports', unit: 'count', align: 'end' },
              { key: 'uses', label: 'Uses', unit: 'count', align: 'end' },
              { key: 'files', label: 'Files', unit: 'count', align: 'end' },
              { key: 'top', label: 'Most used', format: 'code' },
            ],
            rows,
          },
        ]
      : [{ type: 'markdown', text: 'The code imports no declared dependency.' }],
  }
}

function exportsSection(data: UsagesData): Section | undefined {
  const all = data.packages
    .filter((pkg) => !pkg.local)
    .flatMap((pkg) => pkg.exports.map((item) => ({ pkg, item })))
    .toSorted((a, b) => b.item.count - a.item.count)
    .slice(0, limits.exports)
  if (!all.length) return undefined
  const items: Issue[] = all.map(({ pkg, item }) => {
    const site = item.sites[0]
    const names = [
      item.props.length
        ? `Props: ${item.props
            .slice(0, 10)
            .map((p) => `\`${p.name}\` ×${p.count}`)
            .join(', ')}`
        : '',
      item.members.length
        ? `Members: ${item.members
            .slice(0, 10)
            .map((m) => `\`${m.name}\` ×${m.count}`)
            .join(', ')}`
        : '',
    ].filter(Boolean)
    return {
      id: `export-${pkg.name}-${item.subpath}-${item.name}`,
      tone: 'neutral' as const,
      title: `${importPath(pkg.name, item.subpath)} → ${item.name}: ${item.count} uses in ${item.files} files`,
      detail: [
        ...names,
        ...(site ? [`\`${site.file}:${site.line}\`\n\n\`\`\`tsx\n${site.snippet}\n\`\`\``] : []),
      ].join('\n\n'),
      tags: Object.keys(item.kinds),
    }
  })
  return { id: 'exports', title: 'Most used exports', blocks: [{ type: 'issues', items }] }
}

function typesSection(data: UsagesData): Section {
  const { types } = data
  const text =
    types.status === 'used'
      ? `The TypeScript checker read ${types.projects?.length ?? 0} project(s) (${(types.projects ?? []).map((p) => `\`${p}\``).join(', ')}) and found ${types.sites ?? 0} uses that imports alone do not show, such as methods of objects a hook returns.`
      : `Uses come from imports only: the type checker was ${types.status}${types.reason ? ` (${types.reason})` : ''}. Methods of values a package returns and components imported through local re-exports are not counted.`
  const blocks: Block[] = [{ type: 'markdown', text }]
  if (data.problems?.length)
    blocks.push({
      type: 'markdown',
      text: `Unreadable files:\n\n${data.problems.map((p) => `- \`${p}\``).join('\n')}`,
    })
  return { id: 'resolution', title: 'How uses were found', blocks }
}

/** Turns `UsagesData` into a report. Exported for tests and for clients that render locally. */
export function usagesReport(
  data: UsagesData,
  options: { previous?: UsagesData; ref?: string; generatedAt?: string } = {},
): Omit<Report, 'subject'> {
  return {
    kind: 'usages',
    title: 'Package usage',
    ...(options.ref ? { subtitle: options.ref } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    metrics: metrics(data, options.previous),
    sections: [packagesSection(data), exportsSection(data), typesSection(data)].filter(
      (section): section is Section => section !== undefined,
    ),
  }
}

/**
 * The `usages` analysis kind: which packages a repository's code imports, at which versions, and
 * which of their exports, members and JSX props it uses where. The server joins the newest record
 * of every repository into the fleet-wide index behind "used by" and upgrade impact.
 */
export const usagesAnalysis = defineAnalysis<UsagesData>({
  kind: 'usages',
  label: 'Package usage',
  schema: usagesDataSchema,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...usagesReport(current.data, { previous: previous?.data, ref: current.ref }),
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
    }
  },
})

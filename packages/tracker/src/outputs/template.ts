import { z } from 'zod'

import { placeOf } from '../rules/index.ts'
import type { Entity, Finding } from '../types.ts'

/** How an output lays out entities. */
export const templateSchema = z.object({
  /** Heading above the table. */
  title: z.string().min(1).optional(),
  /** Paragraph between heading and table. */
  intro: z.string().min(1).optional(),
  /** Columns in order; `value` is a field name (see `entityField`). Default: key, description, defined in, used in, environments, documented. */
  columns: z
    .array(z.object({ header: z.string().min(1), value: z.string().min(1) }))
    .min(1)
    .optional(),
  /** Field whose value splits the table into groups, each under its own sub-heading. */
  groupBy: z.string().min(1).optional(),
  /** Field to sort by, default `key`. */
  sort: z
    .union([
      z.string().min(1),
      z.object({ by: z.string().min(1), order: z.enum(['asc', 'desc']).default('asc') }),
    ])
    .optional(),
  /** Only entities with an occurrence in one of these roles, e.g. `['definition']`. */
  roles: z.array(z.string().min(1)).optional(),
  /** Append the findings as a list. Default false. */
  findings: z.boolean().default(false),
})

/** A template as configured. */
export type Template = z.output<typeof templateSchema>

/** Columns used when a template names none. */
export const defaultColumns: { header: string; value: string }[] = [
  { header: 'Key', value: 'key' },
  { header: 'Description', value: 'description' },
  { header: 'Defined in', value: 'definedIn' },
  { header: 'Used in', value: 'usedIn' },
  { header: 'Environments', value: 'environments' },
  { header: 'Documented', value: 'documented' },
]

const unique = (values: string[]) => [...new Set(values.filter(Boolean))]

const where = (entity: Entity, role: string) =>
  unique(
    entity.occurrences
      .filter((occurrence) => occurrence.role === role)
      .map((occurrence) =>
        occurrence.document
          ? (occurrence.document.title ?? occurrence.document.ref)
          : [occurrence.repo, occurrence.file].filter(Boolean).join('/') || placeOf(occurrence),
      ),
  )

const environmentText = (values: Record<string, string>) => {
  const entries = Object.entries(values)
  if (entries.length === 1 && entries[0]![0] === 'value') return entries[0]![1]
  return entries.map(([name, value]) => `${name}=${value}`).join(', ')
}

/**
 * Value of one field of an entity as text:
 * `key`, `label` (the `label` attribute, else the first spelling), `labels`, `roles`,
 * `definedIn`, `usedIn` (repositories with usages), `usages` (count), `documented` (yes/no),
 * `environments` (`env: value; ...`), `env:<name>` or `env:<name>.<attr>`, `role:<role>` (places),
 * `findings` (rule ids), and any other name is an attribute.
 */
export function entityField(
  entity: Entity,
  field: string,
  findings: readonly Finding[] = [],
): string {
  switch (field) {
    case 'key':
      return entity.key
    case 'label':
      return entity.attrs.label?.value ?? entity.labels[0] ?? entity.key
    case 'labels':
      return entity.labels.join(', ')
    case 'roles':
      return unique(entity.occurrences.map((occurrence) => occurrence.role)).join(', ')
    case 'definedIn':
      return where(entity, 'definition').join(', ')
    case 'usedIn':
      return unique(
        entity.occurrences
          .filter((occurrence) => occurrence.role === 'usage')
          .map((occurrence) => occurrence.repo ?? occurrence.document?.title ?? ''),
      ).join(', ')
    case 'usages':
      return String(entity.occurrences.filter((occurrence) => occurrence.role === 'usage').length)
    case 'documented':
      return entity.occurrences.some((occurrence) => occurrence.role === 'documentation')
        ? 'yes'
        : 'no'
    case 'environments':
      return Object.entries(entity.environments)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, values]) => `${name}: ${environmentText(values)}`)
        .join('; ')
    case 'findings':
      return unique(
        findings.filter((finding) => finding.key === entity.key).map((finding) => finding.ruleId),
      ).join(', ')
  }
  if (field.startsWith('env:')) {
    const [name = '', attr] = field.slice(4).split('.')
    const values = entity.environments[name]
    if (!values) return ''
    return attr ? (values[attr] ?? '') : environmentText(values)
  }
  if (field.startsWith('role:')) return where(entity, field.slice(5)).join(', ')
  return entity.attrs[field]?.value ?? ''
}

/** A rendered table: headers plus rows of text, optionally grouped. */
export interface RenderedTable {
  headers: string[]
  groups: { name?: string; rows: string[][] }[]
}

/** Entities laid out by a template: filtered by role, sorted, grouped, one row each. */
export function layoutEntities(
  entities: readonly Entity[],
  findings: readonly Finding[],
  template: Template,
): RenderedTable {
  const columns = template.columns ?? defaultColumns
  const sort =
    typeof template.sort === 'string'
      ? { by: template.sort, order: 'asc' as const }
      : (template.sort ?? { by: 'key', order: 'asc' as const })
  const selected = entities
    .filter(
      (entity) =>
        !template.roles ||
        entity.occurrences.some((occurrence) => template.roles!.includes(occurrence.role)),
    )
    .toSorted((a, b) => {
      const order =
        entityField(a, sort.by, findings).localeCompare(
          entityField(b, sort.by, findings),
          undefined,
          { numeric: true },
        ) || a.key.localeCompare(b.key)
      return sort.order === 'desc' ? -order : order
    })
  const row = (entity: Entity) =>
    columns.map((column) => entityField(entity, column.value, findings))
  if (!template.groupBy)
    return {
      headers: columns.map((column) => column.header),
      groups: [{ rows: selected.map(row) }],
    }
  const groups = new Map<string, string[][]>()
  for (const entity of selected) {
    const name = entityField(entity, template.groupBy, findings) || '(none)'
    groups.set(name, [...(groups.get(name) ?? []), row(entity)])
  }
  return {
    headers: columns.map((column) => column.header),
    groups: [...groups]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => ({ name, rows })),
  }
}

const markdownCell = (text: string) => text.replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ') || ' '

/** A Markdown pipe table. */
export function markdownTable(headers: readonly string[], rows: readonly string[][]): string {
  return [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`),
  ].join('\n')
}

/** Escapes text for HTML and XHTML (Confluence storage) bodies. */
export const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/** An HTML table that is also valid Confluence storage XHTML. */
export function htmlTable(headers: readonly string[], rows: readonly string[][]): string {
  const head = `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>`
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<table>${head}<tbody>${body}</tbody></table>`
}

const severityOrder = { error: 0, warning: 1, info: 2 }

/** Findings worst first, then by rule and key. */
export const sortFindings = (findings: readonly Finding[]) =>
  findings.toSorted(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.key.localeCompare(b.key),
  )

/** Entities and, when asked, findings as Markdown or HTML; deterministic for the same input. */
export function renderTemplate(
  entities: readonly Entity[],
  findings: readonly Finding[],
  template: Template,
  format: 'markdown' | 'html',
): string {
  const layout = layoutEntities(entities, findings, template)
  const parts: string[] = []
  const html = format === 'html'
  if (template.title)
    parts.push(html ? `<h2>${escapeHtml(template.title)}</h2>` : `## ${template.title}`)
  if (template.intro) parts.push(html ? `<p>${escapeHtml(template.intro)}</p>` : template.intro)
  for (const group of layout.groups) {
    if (group.name !== undefined)
      parts.push(html ? `<h3>${escapeHtml(group.name)}</h3>` : `### ${group.name}`)
    parts.push(
      group.rows.length
        ? html
          ? htmlTable(layout.headers, group.rows)
          : markdownTable(layout.headers, group.rows)
        : html
          ? '<p>Nothing tracked.</p>'
          : '_Nothing tracked._',
    )
  }
  if (template.findings && findings.length) {
    const items = sortFindings(findings).map((finding) => `${finding.severity}: ${finding.message}`)
    parts.push(
      html
        ? `<h3>Findings</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : `### Findings\n\n${items.map((item) => `- ${item}`).join('\n')}`,
    )
  }
  return parts.join(html ? '' : '\n\n') + (html ? '' : '\n')
}

/** Entities as JSON rows: the template's columns by header, or a summary of every entity. */
export function renderJson(
  entities: readonly Entity[],
  findings: readonly Finding[],
  template: Template,
  tracker: string,
): string {
  const layout = layoutEntities(entities, findings, template)
  const rows = template.columns
    ? layout.groups.flatMap((group) =>
        group.rows.map((row) =>
          Object.fromEntries(layout.headers.map((header, index) => [header, row[index] ?? ''])),
        ),
      )
    : entities
        .toSorted((a, b) => a.key.localeCompare(b.key))
        .filter(
          (entity) =>
            !template.roles ||
            entity.occurrences.some((occurrence) => template.roles!.includes(occurrence.role)),
        )
        .map((entity) => ({
          key: entity.key,
          labels: entity.labels,
          attrs: Object.fromEntries(
            Object.entries(entity.attrs).map(([name, attr]) => [name, attr.value]),
          ),
          environments: entity.environments,
          roles: entityField(entity, 'roles').split(', ').filter(Boolean),
          definedIn: entityField(entity, 'definedIn').split(', ').filter(Boolean),
          usedIn: entityField(entity, 'usedIn').split(', ').filter(Boolean),
          documented: entityField(entity, 'documented') === 'yes',
        }))
  return `${JSON.stringify({ tracker, entities: rows }, null, 2)}\n`
}

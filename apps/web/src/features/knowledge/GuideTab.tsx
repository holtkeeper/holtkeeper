import type { Family, GuideSectionName, RepoRef, RepoSummary } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import { useGuide, useGuideChain } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import {
  type Space,
  layerKinds,
  pendingGenerated,
  sectionRows,
  sectionStatus,
  spaceKey,
  spaceTrail,
  tableLayerKinds,
} from '../../lib/guide.ts'
import { ErrorState, Legend, Placeholder, Table, Tag, Td, Th, Tr } from '../../ui/index.ts'
import { SectionDetail } from './SectionDetail.tsx'

const spaceKindLabel: Record<Space['kind'], string> = {
  all: 'Organization',
  group: 'Team',
  family: 'Family',
  repo: 'Repository',
}

/**
 * The Guide of a space: its identity and the broader spaces it inherits from, a summary strip, a table of sections (which layers give each section text,
 * this space's rules, version, last edit, status) and, for the picked section, its `SectionDetail`
 * with the layers in agent reading order.
 */
export function GuideTab({
  space,
  families,
  repos,
  section,
  onSection,
}: {
  space: Space
  families: readonly Family[]
  /** Visible repositories, for the space's identity and trail; without them neither shows. */
  repos?: readonly RepoSummary[]
  section: GuideSectionName | undefined
  onSection: (section: GuideSectionName | undefined) => void
}) {
  const scope = spaceKey(space)
  const guide = useGuide(scope)
  const repo: RepoRef | undefined = space.kind === 'repo' ? space.repo : undefined
  const chain = useGuideChain(repo)
  const members =
    space.kind === 'family' ? (families.find((f) => f.id === space.family)?.members ?? []) : []

  if (guide.isPending) return <Placeholder className="h-64" />
  if (guide.isError) return <ErrorState error={guide.error} />

  const { sections, canEdit, people } = guide.data
  const rows = sectionRows(sections, repo ? chain.data : undefined)
  const picked = sections.find((s) => s.section === section)
  const rules = rows.reduce((sum, row) => sum + row.rules, 0)
  const learned = sections.reduce((sum, s) => sum + s.learnings.length, 0)
  const waiting = sections.filter((s) => pendingGenerated(s)).length

  const trail = repos ? spaceTrail(space, repos, families) : []
  const here = trail.at(-1)
  const parents = trail.slice(0, -1)

  return (
    <div className="flex flex-col gap-4">
      {repos ? (
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className={`text-[14px] font-semibold ${space.kind === 'repo' ? 'mono' : ''}`}>
              {here?.label ?? 'All repositories'}
            </h2>
            <span className="text-xs text-muted">{spaceKindLabel[space.kind]}</span>
            {space.kind === 'repo' ? (
              <span className="mono text-xs text-dim">{space.repo.forge}</span>
            ) : null}
          </div>
          {parents.length ? (
            <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
              Inherits from
              {parents.map((step, index) => (
                <span key={spaceKey(step.space)} className="inline-flex items-center gap-1">
                  {index ? <ChevronRight aria-hidden className="size-3 text-dim" /> : null}
                  <Link
                    to="/knowledge/guide"
                    search={{ space: spaceKey(step.space) }}
                    className="text-foreground hover:underline"
                  >
                    {step.label}
                  </Link>
                </span>
              ))}
              <ChevronRight aria-hidden className="size-3 text-dim" />
              <span>this {spaceKindLabel[space.kind].toLowerCase()}</span>
            </p>
          ) : null}
        </header>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
        <span>
          <span className="tabular text-foreground">
            {rows.filter((r) => r.status !== 'empty').length}
          </span>{' '}
          sections
        </span>
        <span>
          <span className="tabular text-foreground">{rules}</span> team rules
        </span>
        <span>
          <span className="tabular text-foreground">{learned}</span> learned
        </span>
        {waiting ? (
          <Tag tone="warning" dot>
            {waiting} generated {waiting === 1 ? 'proposal' : 'proposals'} waiting
          </Tag>
        ) : null}
        <span className="ml-auto">{canEdit ? 'You can edit this space' : 'Read only'}</span>
      </div>

      <Legend
        label="Layers"
        items={tableLayerKinds.map((kind) => ({
          tone: 'default',
          label: (
            <>
              <span className="mono text-foreground">{layerKinds[kind].letter}</span>{' '}
              {layerKinds[kind].label}
            </>
          ),
        }))}
      />

      <Table label="Guide sections">
        <thead>
          <tr>
            <Th>Section</Th>
            <Th>Layers</Th>
            <Th align="right">Rules</Th>
            <Th align="right">Version</Th>
            <Th>Updated</Th>
            <Th>Status</Th>
            <Th>
              <span className="sr-only">Open</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Tr
              key={row.section}
              selected={row.section === section}
              onClick={() => onSection(row.section === section ? undefined : row.section)}
            >
              <Td>
                <span className="font-medium">{row.label}</span>
              </Td>
              <Td>
                <span
                  className="mono inline-flex gap-1 text-[11px]"
                  aria-label={
                    row.layers.size
                      ? [...row.layers].map((kind) => layerKinds[kind].label).join(', ')
                      : 'No layers'
                  }
                >
                  {tableLayerKinds.map((kind) => (
                    <span
                      key={kind}
                      aria-hidden
                      className={`grid size-4 place-items-center rounded ${row.layers.has(kind) ? 'bg-raise text-foreground shadow-[0_0_0_1px_var(--line-strong)]' : 'text-dim'}`}
                    >
                      {row.layers.has(kind) ? layerKinds[kind].letter : '–'}
                    </span>
                  ))}
                </span>
              </Td>
              <Td align="right">
                <span className="tabular">{row.rules || '—'}</span>
              </Td>
              <Td align="right">
                <span className="mono text-muted">{row.version ? `v${row.version}` : '—'}</span>
              </Td>
              <Td>
                {row.updatedAt ? (
                  <span className="mono text-xs text-muted" title={formatDateTime(row.updatedAt)}>
                    {formatRelative(row.updatedAt)}
                  </span>
                ) : (
                  <span className="text-dim">—</span>
                )}
              </Td>
              <Td>
                <Tag tone={sectionStatus[row.status].tone} dot={row.status === 'proposal'}>
                  {sectionStatus[row.status].label}
                </Tag>
              </Td>
              <Td align="right">
                <ChevronRight
                  aria-hidden
                  className={`size-3.5 text-dim transition-transform ${row.section === section ? 'rotate-90' : ''}`}
                />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      {picked ? (
        <SectionDetail
          key={`${scope}/${picked.section}/${picked.version}`}
          space={space}
          scope={scope}
          section={picked}
          canEdit={canEdit}
          people={people}
          members={members}
        />
      ) : (
        <p className="text-xs text-dim">
          Pick a section to see its layers in the order agents read them.
        </p>
      )}
    </div>
  )
}

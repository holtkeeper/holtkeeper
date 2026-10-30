import type { SettingDefinitionView } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Wand2 } from 'lucide-react'

import { useRepos, useResolvedSettings } from '../../api/queries.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { previewValue } from '../../lib/schema.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  Loading,
  Panel,
  Select,
  Table,
  Td,
  Th,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'

/** Which entry of every setting wins for a chosen repository. */
export function ResolvePreview({ definitions }: { definitions: readonly SettingDefinitionView[] }) {
  const search = useSearch({ from: '/app/settings' })
  const navigate = useNavigate({ from: '/settings' })
  const repos = useRepos()
  const repo = parseRepoKey(search.repo)
  const resolved = useResolvedSettings(repo)

  return (
    <Panel
      title="Resolve for repository"
      description="The most specific entry covering the repository wins"
      actions={
        <Select
          aria-label="Repository"
          className="w-72"
          placeholder="Choose a repository"
          options={(repos.data?.repos ?? []).map((r) => ({
            id: repoKey(r.repo),
            label: repoKey(r.repo),
          }))}
          value={search.repo}
          onChange={(id) =>
            void navigate({ search: (previous) => ({ ...previous, repo: id }), replace: true })
          }
        />
      }
    >
      {!repo ? (
        <EmptyState
          icon={<Wand2 />}
          title="Pick a repository"
          description="See the effective value of every setting for it."
        />
      ) : resolved.isPending ? (
        <Loading />
      ) : resolved.isError ? (
        <ErrorState error={resolved.error} />
      ) : (
        <div className="flex flex-col gap-3">
          {resolved.data.groups.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              Groups:
              {resolved.data.groups.map((group) => (
                <Chip key={group}>{group}</Chip>
              ))}
            </div>
          ) : null}
          <Table label="Resolved settings">
            <thead>
              <tr>
                <Th>Setting</Th>
                <Th>Value</Th>
                <Th>From</Th>
              </tr>
            </thead>
            <tbody>
              {definitions.map((definition) => {
                const winner = resolved.data.settings[definition.key]
                return (
                  <tr key={definition.key}>
                    <Td>
                      <div className="font-medium">{definition.label}</div>
                      <div className="font-mono text-[11px] text-muted">{definition.key}</div>
                    </Td>
                    <Td className="max-w-xs truncate font-mono text-xs">
                      {winner ? (
                        previewValue(winner.value, winner.secret)
                      ) : (
                        <span className="text-muted">default</span>
                      )}
                    </Td>
                    <Td>{winner ? <ScopeBadge scope={winner.scope} /> : null}</Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </div>
      )}
    </Panel>
  )
}

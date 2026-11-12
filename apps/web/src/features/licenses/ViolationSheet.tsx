import { type LicensePolicySummary, type LicenseViolation, leafGroups } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Copy, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import {
  alternativeRequest,
  verdictLabel,
  verdictTone,
  violationLicense,
} from '../../lib/licenses.ts'
import { parseRepoKey, repoSplat } from '../../lib/repo.ts'
import {
  GroupName,
  KeyValue,
  notify,
  quietActionsOf,
  SideSheet,
  Table,
  Tag,
  Td,
  Th,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { ExceptionDialog } from './ExceptionDialog.tsx'

const tabs = [
  { id: 'repos', label: 'Repositories' },
  { id: 'policy', label: 'Policy' },
] as const

function Repositories({ violation }: { violation: LicenseViolation }) {
  return (
    <Table label="Repositories using this package">
      <thead>
        <tr>
          <Th>Repository</Th>
          <Th>Groups</Th>
        </tr>
      </thead>
      <tbody>
        {violation.repos.map((entry) => {
          const ref = parseRepoKey(entry.repo)
          return (
            <tr key={entry.repo}>
              <Td>
                {ref ? (
                  <Link
                    to="/repos/$"
                    params={{ _splat: repoSplat(ref) }}
                    search={{ tab: 'supply', section: 'licenses' }}
                    className="mono text-[12.5px] hover:underline"
                  >
                    {ref.path}
                  </Link>
                ) : (
                  <span className="mono text-[12.5px]">{entry.repo}</span>
                )}
              </Td>
              <Td>
                <span className="flex flex-wrap gap-1">
                  {leafGroups(entry.groups).map((group) => (
                    <Tag key={group}>
                      <GroupName group={group} path />
                    </Tag>
                  ))}
                </span>
              </Td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

function Policy({
  violation,
  policy,
}: {
  violation: LicenseViolation
  policy: LicensePolicySummary | undefined
}) {
  return (
    <div className="flex flex-col gap-3">
      <KeyValue
        rows={[
          {
            label: 'Declared',
            value: violation.licenses.length ? (
              <span className="mono">{violation.licenses.join(', ')}</span>
            ) : (
              <span className="text-muted">No recognizable license</span>
            ),
          },
          {
            label: 'Verdict',
            value: (
              <Tag tone={verdictTone(violation.verdict)} dot>
                {verdictLabel[violation.verdict]}
              </Tag>
            ),
          },
          {
            label: 'Because of',
            value: violation.culprits.length ? (
              <span className="mono">{violation.culprits.join(', ')}</span>
            ) : violation.verdict === 'unknown' ? (
              'Unknown licenses need review'
            ) : (
              'Not on the allow list'
            ),
          },
          { label: 'Preset', value: policy?.preset },
        ]}
      />
      <p className="text-xs text-muted">
        The verdict is the worst one any of its repositories gives it under the policy that applies
        there.
      </p>
    </div>
  )
}

/**
 * One license violation in the side sheet: verdict, versions, repositories and policy rule, with
 * **Add exception…** (`settings:write`) and **Copy request**, a note asking for an alternative.
 */
export function ViolationSheet({
  violation,
  policy,
  tab,
  onTab,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  violation: LicenseViolation | undefined
  policy: LicensePolicySummary | undefined
  tab: string | undefined
  onTab: (tab: string) => void
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const { can } = useSession()
  const [excepting, setExcepting] = useState(false)
  if (!violation) return null
  const current = tabs.find((entry) => entry.id === tab)?.id ?? 'repos'
  const copyRequest = async () => {
    try {
      await navigator.clipboard.writeText(alternativeRequest(violation))
      notify.success('Request copied')
    } catch {
      notify.error('Not copied', 'The browser did not allow the clipboard.')
    }
  }
  const quiet = quietActionsOf([
    ...(can('settings:write')
      ? [{ label: 'Add exception…', icon: ShieldCheck, onPress: () => setExcepting(true) }]
      : []),
    { label: 'Copy request', icon: Copy, onPress: () => void copyRequest() },
  ])
  return (
    <SideSheet
      open
      onClose={onClose}
      {...(quiet && { quietActions: quiet })}
      id={`${violationLicense(violation)} · ${violation.package}`}
      title={`${violation.package} under ${violationLicense(violation)}`}
      {...(index !== undefined && total !== undefined ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      tabs={{
        items: tabs.map((entry) => ({
          id: entry.id,
          label: entry.id === 'repos' ? `Repositories ${violation.repos.length}` : entry.label,
        })),
        selected: current,
        onSelect: onTab,
        'aria-label': 'Violation sections',
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Tag tone={verdictTone(violation.verdict)} dot>
            {verdictLabel[violation.verdict]}
          </Tag>
          <span>{violation.ecosystem}</span>
          <span className="mono">{violation.versions.join(', ')}</span>
          {violation.dev ? <Tag>Dev only</Tag> : null}
        </div>
        {current === 'repos' ? (
          <Repositories violation={violation} />
        ) : (
          <Policy violation={violation} policy={policy} />
        )}
      </div>
      {excepting ? (
        <ExceptionDialog violation={violation} onClose={() => setExcepting(false)} />
      ) : null}
    </SideSheet>
  )
}

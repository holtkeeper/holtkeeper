import {
  AUTO_ACCEPT_ACTOR,
  type GuideGeneratedVersionView,
  type GuideScopeKey,
  type GuideSectionName,
} from '@holtkeeper/api'
import { X } from 'lucide-react'
import { useState } from 'react'

import { useGuideGeneratedHistory } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import { lineDiff } from '../../lib/guide.ts'
import { Button, ErrorState, Placeholder, Segmented, Select } from '../../ui/index.ts'
import { type DiffMode, FileDiffView } from '../reports/blocks/DiffView.tsx'

const versionLabel = (version: GuideGeneratedVersionView) =>
  [
    `v${version.version}`,
    version.current === 'generated' ? 'accepted' : version.current === 'proposal' ? 'proposed' : '',
    version.acceptedBy === AUTO_ACCEPT_ACTOR.id ? 'auto-accepted' : '',
    version.rejected ? 'rejected' : '',
    formatRelative(version.generatedAt),
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * Two stored generated versions of a section side by side: by default the newest against the one
 * before it; either can be picked from the section's generated history.
 */
export function GeneratedCompare({
  scope,
  section,
  onClose,
}: {
  scope: GuideScopeKey
  section: GuideSectionName
  onClose: () => void
}) {
  const history = useGuideGeneratedHistory(scope, section)
  const [picked, setPicked] = useState<{ before?: number; after?: number }>({})
  const [mode, setMode] = useState<DiffMode>('split')

  const body = () => {
    if (history.isPending) return <Placeholder className="h-40" />
    if (history.isError) return <ErrorState error={history.error} />
    const versions = history.data.versions
    if (versions.length < 2)
      return <p className="text-sm text-muted">Only one generated version is stored so far.</p>
    const after = versions.find((v) => v.version === picked.after) ?? versions[0]
    const before =
      versions.find((v) => v.version === picked.before) ??
      versions.find((v) => v.version < (after?.version ?? 0)) ??
      versions[1]
    if (!after || !before) return null
    const options = versions.map((v) => ({ id: String(v.version), label: versionLabel(v) }))
    return (
      <>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Before"
            options={options}
            value={String(before.version)}
            onChange={(id) => setPicked((now) => ({ ...now, before: Number(id) }))}
          />
          <Select
            label="After"
            options={options}
            value={String(after.version)}
            onChange={(id) => setPicked((now) => ({ ...now, after: Number(id) }))}
          />
          <Segmented
            aria-label="Diff layout"
            options={[
              { id: 'split', label: 'Split' },
              { id: 'unified', label: 'Unified' },
            ]}
            value={mode}
            onChange={setMode}
          />
        </div>
        <FileDiffView
          key={`${before.version}-${after.version}`}
          file={{
            file: `v${before.version} → v${after.version}`,
            status: 'modified',
            hunks: [lineDiff(before.body, after.body)],
          }}
          mode={mode}
          formatted={false}
          defaultOpen
        />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-raise p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">Compare generated versions</h4>
        <Button variant="ghost" size="sm" isIconOnly aria-label="Close compare" onPress={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      {body()}
    </div>
  )
}

import type { GuideScopeKey, GuideSectionName } from '@holtkeeper/api'
import { RotateCcw } from 'lucide-react'

import { messageOf } from '../../api/client.ts'
import { useGuideMutations, useGuideSection } from '../../api/queries.ts'
import { sectionLabel } from '../../lib/guide.ts'
import {
  Button,
  ErrorState,
  Markdown,
  Placeholder,
  SideSheet,
  Tag,
  notify,
} from '../../ui/index.ts'
import { Byline } from './parts.tsx'

/** Revisions of a section's team rules and steering, newest first, each restorable. */
export function HistorySheet({
  scope,
  section,
  onClose,
}: {
  scope: GuideScopeKey
  section: GuideSectionName
  onClose: () => void
}) {
  const detail = useGuideSection(scope, section)
  const { restore } = useGuideMutations()

  return (
    <SideSheet open onClose={onClose} id={scope} title={`${sectionLabel(section)} history`}>
      {detail.isPending ? (
        <Placeholder className="h-40" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : (
        <ol className="flex flex-col gap-3">
          <li className="flex flex-col gap-2 rounded-xl border border-line bg-raise p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone="accent" mono>
                v{detail.data.section.version}
              </Tag>
              <Tag>current</Tag>
              <Byline
                verb="edited"
                id={detail.data.section.editedBy}
                at={detail.data.section.editedAt}
                people={detail.data.people}
              />
            </div>
            <Revision rules={detail.data.section.rules} steering={detail.data.section.steering} />
          </li>
          {detail.data.history.map((revision) => (
            <li
              key={revision.version}
              className="flex flex-col gap-2 rounded-xl border border-line p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Tag mono>v{revision.version}</Tag>
                <Byline
                  verb="edited"
                  id={revision.editedBy}
                  at={revision.editedAt}
                  people={detail.data.people}
                />
                {detail.data.canEdit ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    isPending={restore.isPending}
                    onPress={() =>
                      restore.mutate(
                        { scope, section, version: revision.version },
                        {
                          onSuccess: () => {
                            notify.success('Revision restored', `v${revision.version}`)
                            onClose()
                          },
                          onError: (error) => notify.error('Not restored', messageOf(error)),
                        },
                      )
                    }
                  >
                    <RotateCcw className="size-3.5" />
                    Restore
                  </Button>
                ) : null}
              </div>
              <Revision rules={revision.rules} steering={revision.steering} />
            </li>
          ))}
          {detail.data.history.length === 0 ? (
            <li className="text-sm text-muted">No earlier revisions.</li>
          ) : null}
        </ol>
      )}
    </SideSheet>
  )
}

function Revision({ rules, steering }: { rules: string; steering: string }) {
  return (
    <>
      {rules.trim() ? (
        <Markdown text={rules} className="text-muted" />
      ) : (
        <span className="text-sm text-dim">No team rules.</span>
      )}
      {steering ? <span className="text-xs text-muted">Steering: {steering}</span> : null}
    </>
  )
}

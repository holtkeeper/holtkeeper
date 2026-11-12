import type { SystemHealth } from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/api'
import { TriangleAlert } from 'lucide-react'

import { quotaUse, retentionLabel, storageShade } from '../../lib/storage.ts'
import { statusColor } from '../../ui/colors.ts'
import { KeyValue, Tag } from '../../ui/index.ts'

const checkTag = {
  ok: { tone: 'success', label: 'Reachable' },
  warn: { tone: 'warning', label: 'Degraded' },
  error: { tone: 'danger', label: 'Unreachable' },
} as const

/**
 * The side card of Settings › System › Storage about the artifact store: whether it answers,
 * where it is, how much it holds against the operator's declared quota (bar only when one is
 * set) and Holtkeeper's retention. Renders nothing when the server reports no store.
 */
export function ArtifactStoreCard({ health }: { health: SystemHealth | undefined }) {
  const view = health?.artifactStore
  if (!view) return null
  const check = health.checks.find((entry) => entry.id === 'artifacts')
  const tag = check ? checkTag[check.status] : undefined
  const use = quotaUse(view.usedBytes, view.quotaBytes)
  const s3 = view.kind === 's3'

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-semibold">
          {s3 ? 'S3 bucket' : 'Artifact directory'}
        </span>
        {tag ? (
          <Tag
            tone={tag.tone}
            dot
            className="ms-auto"
            {...(check?.detail ? { title: check.detail } : {})}
          >
            {tag.label}
          </Tag>
        ) : null}
      </div>
      <KeyValue
        labelWidth={72}
        rows={[
          ...(s3
            ? [
                {
                  label: 'Endpoint',
                  value: view.endpoint ? (
                    <span className="mono truncate">{view.endpoint}</span>
                  ) : (
                    <span className="text-muted">AWS</span>
                  ),
                },
                {
                  label: 'Bucket',
                  value: (
                    <>
                      <span className="mono truncate">{view.bucket}</span>
                      {view.region ? <span className="text-muted">{view.region}</span> : null}
                    </>
                  ),
                },
                {
                  label: 'Prefix',
                  value: view.prefix ? <span className="mono truncate">{view.prefix}/</span> : null,
                },
              ]
            : [
                {
                  label: 'Directory',
                  value: (
                    <span className="mono truncate" title={view.dir}>
                      {view.dir}
                    </span>
                  ),
                },
              ]),
          {
            label: 'Used',
            value:
              view.usedBytes !== undefined ? (
                <>
                  <span className="mono">{formatBytes(view.usedBytes)}</span>
                  {view.quotaBytes ? (
                    <span className="text-muted" title="Declared by the operator, not measured">
                      of {formatBytes(view.quotaBytes)} quota
                    </span>
                  ) : null}
                </>
              ) : null,
          },
          {
            label: 'Objects',
            value:
              view.objects !== undefined ? (
                <span className="mono">{view.objects.toLocaleString('en-US')}</span>
              ) : null,
          },
          {
            label: 'Retention',
            value: <span className="text-muted">{retentionLabel(view.retention)}</span>,
          },
        ]}
      />
      {view.error ? (
        <div className="flex items-center gap-1 text-[11.5px] text-bad">
          <TriangleAlert aria-hidden className="size-3 shrink-0" />
          Could not measure: {view.error}
        </div>
      ) : null}
      {use ? (
        <div className="flex items-center gap-2">
          <span
            role="img"
            aria-label={`${use.label} of the declared quota used`}
            className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-line"
          >
            <span
              className="block h-full rounded-[3px]"
              style={{
                width: `${use.width}%`,
                background: use.tone === 'default' ? storageShade(0) : statusColor[use.tone],
              }}
            />
          </span>
          <span className="mono text-[11.5px] text-muted">{use.label}</span>
        </div>
      ) : null}
    </div>
  )
}

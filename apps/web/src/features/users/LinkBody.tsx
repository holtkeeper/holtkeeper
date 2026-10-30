import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { CopyField } from '../../ui/index.ts'

/** A one-time link with its copy button and expiry. */
export function LinkBody({ url, expiresAt }: { url: string; expiresAt: string }) {
  return (
    <div className="flex flex-col gap-2">
      <CopyField value={url} label="link" />
      <p className="text-xs text-muted" title={formatDateTime(expiresAt)}>
        Expires {formatRelative(expiresAt)}.
      </p>
    </div>
  )
}

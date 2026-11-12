import type { UnknownSettingKeyView } from '@holtkeeper/api'
import { TriangleAlert } from 'lucide-react'

import { unknownKeysWarning } from '../../lib/resolved-settings.ts'

/** A warning line for an entry carrying keys its setting ignores; nothing when there are none. */
export function UnknownKeys({
  keys,
  className = '',
}: {
  keys: readonly UnknownSettingKeyView[] | undefined
  className?: string
}) {
  const text = unknownKeysWarning(keys)
  if (!text) return null
  return (
    <p role="status" className={`flex items-start gap-1.5 text-xs text-warning ${className}`}>
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  )
}

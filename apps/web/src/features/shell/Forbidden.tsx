import { ShieldX } from 'lucide-react'

import { EmptyState } from '../../ui/index.ts'

/** Shown on pages the principal has no grant for. */
export function Forbidden() {
  return (
    <EmptyState
      icon={<ShieldX />}
      title="No access"
      description="None of your grants allow this page."
    />
  )
}

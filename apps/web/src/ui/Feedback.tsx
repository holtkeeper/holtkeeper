import { Alert, Skeleton, Spinner } from '@heroui/react'
import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import { isForbidden, messageOf } from '../api/client.ts'
import { Forbidden } from '../features/shell/Forbidden.tsx'

/** Centered message for empty lists and blank states. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon ? (
        <div className="mb-1 rounded-2xl bg-default p-3 text-muted [&_svg]:size-6">{icon}</div>
      ) : null}
      <div className="font-medium">{title}</div>
      {description ? <div className="max-w-md text-sm text-muted">{description}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

/** An inline notice. */
export function Notice({
  tone = 'default',
  title,
  children,
}: {
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger'
  title: ReactNode
  children?: ReactNode
}) {
  return (
    <Alert status={tone}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        {children ? <Alert.Description>{children}</Alert.Description> : null}
      </Alert.Content>
    </Alert>
  )
}

/**
 * A failed query: for a 403 the card naming the missing permission and what the viewer has,
 * otherwise the error message.
 */
export function ErrorState({ error }: { error: unknown }) {
  return isForbidden(error) ? (
    <Forbidden error={error} />
  ) : (
    <EmptyState icon={<TriangleAlert />} title="Could not load" description={messageOf(error)} />
  )
}

/** Loading indicator for a whole section. */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted" role="status">
      <Spinner size="sm" />
      {label}
    </div>
  )
}

/** Placeholder block while content loads. */
export function Placeholder({ className }: { className?: string }) {
  return <Skeleton className={`rounded-xl ${className ?? 'h-24'}`} />
}

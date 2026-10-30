import { Card } from '@heroui/react'
import type { ReactNode } from 'react'

export interface PanelProps {
  title?: ReactNode
  description?: ReactNode
  /** Controls shown at the right of the title. */
  actions?: ReactNode
  children?: ReactNode
  className?: string
  contentClassName?: string
  variant?: 'default' | 'secondary' | 'tertiary' | 'transparent'
}

/** A titled surface for grouping content on a page. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
  variant,
}: PanelProps) {
  return (
    <Card className={className} variant={variant ?? 'default'}>
      {title || actions ? (
        <Card.Header className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <Card.Title className="text-base font-semibold">{title}</Card.Title> : null}
            {description ? <Card.Description>{description}</Card.Description> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </Card.Header>
      ) : null}
      <Card.Content className={contentClassName}>{children}</Card.Content>
    </Card>
  )
}

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
  /** `flush` drops the surface box: a top hairline, a 13px `h2` title row and the content. */
  variant?: 'default' | 'secondary' | 'tertiary' | 'transparent' | 'flush'
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
  if (variant === 'flush') {
    return (
      <section
        className={`flex min-w-0 flex-col gap-3 border-t border-line pt-3 ${className ?? ''}`}
      >
        {title || actions ? (
          <header className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="min-w-0">
              {title ? <h2 className="text-[13px] font-semibold">{title}</h2> : null}
              {description ? <p className="text-xs text-muted">{description}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </header>
        ) : null}
        <div className={contentClassName}>{children}</div>
      </section>
    )
  }
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

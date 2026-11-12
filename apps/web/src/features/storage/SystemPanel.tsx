import { type ReactNode, useId } from 'react'

/**
 * One block of Settings › System: a sunken panel with a title row (title, quiet description,
 * figures or actions on the right) and its content below a hairline. `id` is the anchor the
 * section's sub-navigation links to.
 */
export function SystemPanel({
  id,
  title,
  description,
  aside,
  children,
}: {
  id: string
  title: ReactNode
  description?: ReactNode
  /** Right side of the title row: a total, a status tag or buttons. */
  aside?: ReactNode
  children: ReactNode
}) {
  const heading = useId()
  return (
    <section
      id={id}
      aria-labelledby={heading}
      className="min-w-0 scroll-mt-3 overflow-hidden rounded-[10px] border border-line bg-sunk"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-3">
        <h2 id={heading} className="text-[13.5px] font-semibold">
          {title}
        </h2>
        {description ? <span className="text-xs text-muted">{description}</span> : null}
        {aside ? (
          <div className="ms-auto flex flex-wrap items-center gap-2 text-xs text-muted">
            {aside}
          </div>
        ) : null}
      </header>
      {children}
    </section>
  )
}

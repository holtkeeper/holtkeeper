import { useState } from 'react'

import { initialsOf } from '../lib/people.ts'

const sizes = { xs: 'size-5 text-[9px]', sm: 'size-8 text-xs', lg: 'size-14 text-lg' }

/** A generated avatar image; falls back to initials when it cannot load. */
export function Avatar({
  src,
  name,
  size = 'sm',
  className,
}: {
  src: string
  name: string
  size?: keyof typeof sizes
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const box = `${sizes[size]} shrink-0 rounded-full bg-default ${className ?? ''}`
  if (failed) {
    return (
      <span
        aria-hidden
        className={`${box} grid place-items-center bg-accent-soft font-semibold text-accent-soft-foreground`}
      >
        {initialsOf(name)}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={`${box} object-cover`}
    />
  )
}

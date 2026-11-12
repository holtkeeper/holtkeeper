import holtkeeper from '@holtkeeper/brand/holtkeeper.svg'

/** The Holtkeeper mascot from `@holtkeeper/brand`; decorative. */
export function BrandIcon({ className }: { className?: string }) {
  return <img src={holtkeeper} alt="" aria-hidden draggable={false} className={className} />
}

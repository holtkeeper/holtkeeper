import audit from '@holtkeeper/brand/audit.svg'
import browserslist from '@holtkeeper/brand/browserslist.svg'
import bundles from '@holtkeeper/brand/bundles.svg'
import credentials from '@holtkeeper/brand/credentials.svg'
import holtkeeper from '@holtkeeper/brand/holtkeeper.svg'
import knowledge from '@holtkeeper/brand/knowledge.svg'
import quality from '@holtkeeper/brand/quality.svg'
import release from '@holtkeeper/brand/release.svg'
import repos from '@holtkeeper/brand/repos.svg'
import review from '@holtkeeper/brand/review.svg'
import updates from '@holtkeeper/brand/updates.svg'

const icons = {
  audit,
  browserslist,
  bundles,
  credentials,
  holtkeeper,
  knowledge,
  quality,
  release,
  repos,
  review,
  updates,
}

export type BrandIconName = keyof typeof icons

/** The mascot or a capability icon from `@holtkeeper/brand`; decorative. */
export function BrandIcon({ name, className }: { name: BrandIconName; className?: string }) {
  return <img src={icons[name]} alt="" aria-hidden draggable={false} className={className} />
}

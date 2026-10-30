import api from '@holtkeeper/brand/api.svg'
import assets from '@holtkeeper/brand/assets.svg'
import audit from '@holtkeeper/brand/audit.svg'
import branches from '@holtkeeper/brand/branches.svg'
import browserslist from '@holtkeeper/brand/browserslist.svg'
import bundles from '@holtkeeper/brand/bundles.svg'
import ci from '@holtkeeper/brand/ci.svg'
import coverage from '@holtkeeper/brand/coverage.svg'
import credentials from '@holtkeeper/brand/credentials.svg'
import fleet from '@holtkeeper/brand/fleet.svg'
import holtkeeper from '@holtkeeper/brand/holtkeeper.svg'
import knowledge from '@holtkeeper/brand/knowledge.svg'
import licenses from '@holtkeeper/brand/licenses.svg'
import quality from '@holtkeeper/brand/quality.svg'
import release from '@holtkeeper/brand/release.svg'
import repos from '@holtkeeper/brand/repos.svg'
import review from '@holtkeeper/brand/review.svg'
import stack from '@holtkeeper/brand/stack.svg'
import testids from '@holtkeeper/brand/testids.svg'
import updates from '@holtkeeper/brand/updates.svg'

const icons = {
  api,
  assets,
  audit,
  branches,
  browserslist,
  bundles,
  ci,
  coverage,
  credentials,
  fleet,
  holtkeeper,
  knowledge,
  licenses,
  quality,
  release,
  repos,
  review,
  stack,
  testids,
  updates,
}

export type BrandIconName = keyof typeof icons

/** The mascot or a capability icon from `@holtkeeper/brand`; decorative. */
export function BrandIcon({ name, className }: { name: BrandIconName; className?: string }) {
  return <img src={icons[name]} alt="" aria-hidden draggable={false} className={className} />
}

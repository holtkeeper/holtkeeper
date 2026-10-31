import activity from '@holtkeeper/brand/activity.svg'
import ai from '@holtkeeper/brand/ai.svg'
import api from '@holtkeeper/brand/api.svg'
import assets from '@holtkeeper/brand/assets.svg'
import audit from '@holtkeeper/brand/audit.svg'
import auditlog from '@holtkeeper/brand/auditlog.svg'
import automation from '@holtkeeper/brand/automation.svg'
import branches from '@holtkeeper/brand/branches.svg'
import browserslist from '@holtkeeper/brand/browserslist.svg'
import bundles from '@holtkeeper/brand/bundles.svg'
import ci from '@holtkeeper/brand/ci.svg'
import coverage from '@holtkeeper/brand/coverage.svg'
import credentials from '@holtkeeper/brand/credentials.svg'
import fleet from '@holtkeeper/brand/fleet.svg'
import holtkeeper from '@holtkeeper/brand/holtkeeper.svg'
import jobs from '@holtkeeper/brand/jobs.svg'
import knowledge from '@holtkeeper/brand/knowledge.svg'
import licenses from '@holtkeeper/brand/licenses.svg'
import quality from '@holtkeeper/brand/quality.svg'
import release from '@holtkeeper/brand/release.svg'
import repos from '@holtkeeper/brand/repos.svg'
import review from '@holtkeeper/brand/review.svg'
import settings from '@holtkeeper/brand/settings.svg'
import stack from '@holtkeeper/brand/stack.svg'
import storage from '@holtkeeper/brand/storage.svg'
import testids from '@holtkeeper/brand/testids.svg'
import updates from '@holtkeeper/brand/updates.svg'
import users from '@holtkeeper/brand/users.svg'
import warmup from '@holtkeeper/brand/warmup.svg'

const icons = {
  activity,
  ai,
  api,
  assets,
  audit,
  auditlog,
  automation,
  branches,
  browserslist,
  bundles,
  ci,
  coverage,
  credentials,
  fleet,
  holtkeeper,
  jobs,
  knowledge,
  licenses,
  quality,
  release,
  repos,
  review,
  settings,
  stack,
  storage,
  testids,
  updates,
  users,
  warmup,
}

export type BrandIconName = keyof typeof icons

/** URL of a brand icon, usable as an image source or favicon. */
export const brandIconUrl = (name: BrandIconName): string => icons[name]

/** The mascot or a capability icon from `@holtkeeper/brand`; decorative. */
export function BrandIcon({ name, className }: { name: BrandIconName; className?: string }) {
  return <img src={icons[name]} alt="" aria-hidden draggable={false} className={className} />
}

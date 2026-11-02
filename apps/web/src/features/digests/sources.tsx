import {
  Boxes,
  Gauge,
  GitBranch,
  Images,
  type LucideIcon,
  Rocket,
  Scale,
  ShieldAlert,
  Ship,
  Sparkles,
  Timer,
  Workflow,
} from 'lucide-react'

const icons: Record<string, LucideIcon> = {
  licenses: Scale,
  audit: ShieldAlert,
  assets: Images,
  bundle: Boxes,
  quality: Gauge,
  delivery: Rocket,
  'ci-jobs': Timer,
  branches: GitBranch,
  'release-risk': Sparkles,
  fleet: Ship,
}

/** The icon of a digest section's analysis kind. */
export const sourceIcon = (kind: string): LucideIcon => icons[kind] ?? Workflow

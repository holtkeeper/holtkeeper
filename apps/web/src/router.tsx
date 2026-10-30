import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from '@tanstack/react-router'

import { LinkPage } from './features/auth/LinkPage.tsx'
import { AuthGate } from './features/shell/AuthGate.tsx'
import { NotFound } from './features/shell/NotFound.tsx'
import { ToastHost } from './ui/index.ts'

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <ToastHost />
    </>
  ),
  notFoundComponent: NotFound,
})

const linkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'link/$token',
  component: LinkPage,
})

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AuthGate })

const page = <P extends string>(path: P, component: ReturnType<typeof lazyRouteComponent>) =>
  createRoute({ getParentRoute: () => appRoute, path, component })

const DashboardPage = lazyRouteComponent(
  () => import('./features/dashboard/DashboardPage.tsx'),
  'DashboardPage',
)
const ReposPage = lazyRouteComponent(() => import('./features/repos/ReposPage.tsx'), 'ReposPage')
const AuditsPage = lazyRouteComponent(
  () => import('./features/audits/AuditsPage.tsx'),
  'AuditsPage',
)
const AuditRunPage = lazyRouteComponent(
  () => import('./features/audits/AuditRunPage.tsx'),
  'AuditRunPage',
)
const CredentialsPage = lazyRouteComponent(
  () => import('./features/credentials/CredentialsPage.tsx'),
  'CredentialsPage',
)
const SettingsPage = lazyRouteComponent(
  () => import('./features/settings/SettingsPage.tsx'),
  'SettingsPage',
)
const UsersPage = lazyRouteComponent(() => import('./features/users/UsersPage.tsx'), 'UsersPage')
const AccountPage = lazyRouteComponent(
  () => import('./features/account/AccountPage.tsx'),
  'AccountPage',
)
const ReleasesPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'ReleasesPage',
)
const BundlesPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'BundlesPage',
)
const DependenciesPage = lazyRouteComponent(
  () => import('./features/dependencies/DependenciesPage.tsx'),
  'DependenciesPage',
)
const QualityPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'QualityPage',
)
const CiJobsPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'CiJobsPage',
)
const CoveragePage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'CoveragePage',
)
const TestIdsPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'TestIdsPage',
)
const BranchesPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'BranchesPage',
)
const LicensesPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'LicensesPage',
)
const AnalysisPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysisPage.tsx'),
  'AnalysisPage',
)
const RepoPage = lazyRouteComponent(() => import('./features/repos/RepoPage.tsx'), 'RepoPage')
const GroupPage = lazyRouteComponent(() => import('./features/repos/GroupPage.tsx'), 'GroupPage')
const KnowledgePage = lazyRouteComponent(
  () => import('./features/knowledge/KnowledgePage.tsx'),
  'KnowledgePage',
)
const ActivityPage = lazyRouteComponent(
  () => import('./features/activity/ActivityPage.tsx'),
  'ActivityPage',
)

const JobsPage = lazyRouteComponent(() => import('./features/jobs/JobsPage.tsx'), 'JobsPage')
const JobPage = lazyRouteComponent(() => import('./features/jobs/JobPage.tsx'), 'JobPage')
const AutomationPage = lazyRouteComponent(
  () => import('./features/automation/AutomationPage.tsx'),
  'AutomationPage',
)
const AiUsagePage = lazyRouteComponent(() => import('./features/ai/AiUsagePage.tsx'), 'AiUsagePage')
const AuditLogPage = lazyRouteComponent(
  () => import('./features/audit-log/AuditLogPage.tsx'),
  'AuditLogPage',
)
const StoragePage = lazyRouteComponent(
  () => import('./features/storage/StoragePage.tsx'),
  'StoragePage',
)

const auditsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'audits',
  component: AuditsPage,
  validateSearch: (search: Record<string, unknown>): { repo?: string } =>
    typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {},
})

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings',
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): { repo?: string; tab?: string } => ({
    ...(typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {}),
    ...(typeof search.tab === 'string' && search.tab ? { tab: search.tab } : {}),
  }),
})

const tabSearch = (search: Record<string, unknown>): { tab?: string } =>
  typeof search.tab === 'string' && search.tab ? { tab: search.tab } : {}

const repoRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'repos/view',
  component: RepoPage,
  validateSearch: (search: Record<string, unknown>): { repo?: string; tab?: string } => ({
    ...(typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {}),
    ...tabSearch(search),
  }),
})

const groupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'repos/groups/$groupId',
  component: GroupPage,
  validateSearch: tabSearch,
})

const jobsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'jobs',
  component: JobsPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { repo?: string; status?: string; schedule?: string } => ({
    ...(typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {}),
    ...(typeof search.status === 'string' && search.status ? { status: search.status } : {}),
    ...(typeof search.schedule === 'string' && search.schedule
      ? { schedule: search.schedule }
      : {}),
  }),
})

const automationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'automation',
  component: AutomationPage,
  validateSearch: tabSearch,
})

const repoSearch = (search: Record<string, unknown>): { repo?: string } =>
  typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {}

const analysisPage = <P extends string>(
  path: P,
  component: ReturnType<typeof lazyRouteComponent>,
) => createRoute({ getParentRoute: () => appRoute, path, component, validateSearch: repoSearch })

const analysisRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'analyses/$id',
  component: AnalysisPage,
  validateSearch: (search: Record<string, unknown>): { compare?: string } =>
    typeof search.compare === 'string' && search.compare ? { compare: search.compare } : {},
})

const routeTree = rootRoute.addChildren([
  linkRoute,
  appRoute.addChildren([
    page('/', DashboardPage),
    page('repos', ReposPage),
    repoRoute,
    groupRoute,
    auditsRoute,
    page('audits/$runId', AuditRunPage),
    analysisPage('releases', ReleasesPage),
    analysisPage('bundles', BundlesPage),
    analysisPage('dependencies', DependenciesPage),
    analysisPage('quality', QualityPage),
    analysisPage('coverage', CoveragePage),
    analysisPage('testids', TestIdsPage),
    analysisPage('branches', BranchesPage),
    analysisPage('ci', CiJobsPage),
    analysisPage('licenses', LicensesPage),
    analysisRoute,
    jobsRoute,
    page('jobs/$jobId', JobPage),
    page('knowledge', KnowledgePage),
    automationRoute,
    page('ai', AiUsagePage),
    page('audit-log', AuditLogPage),
    page('storage', StoragePage),
    page('credentials', CredentialsPage),
    settingsRoute,
    page('users', UsersPage),
    page('account', AccountPage),
    page('activity', ActivityPage),
  ]),
])

export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

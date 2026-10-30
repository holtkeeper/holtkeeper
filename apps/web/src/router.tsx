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
  () => import('./features/analyses/AnalysesPage.tsx'),
  'DependenciesPage',
)
const QualityPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'QualityPage',
)
const AnalysisPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysisPage.tsx'),
  'AnalysisPage',
)
const ActivityPage = lazyRouteComponent(
  () => import('./features/activity/ActivityPage.tsx'),
  'ActivityPage',
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
  validateSearch: (search: Record<string, unknown>): { repo?: string } =>
    typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {},
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
    auditsRoute,
    page('audits/$runId', AuditRunPage),
    analysisPage('releases', ReleasesPage),
    analysisPage('bundles', BundlesPage),
    analysisPage('dependencies', DependenciesPage),
    analysisPage('quality', QualityPage),
    analysisRoute,
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

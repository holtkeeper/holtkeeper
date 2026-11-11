import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router'

import { type AuditsSearch, isTrigger } from './features/audits/labels.ts'
import { LinkPage } from './features/auth/LinkPage.tsx'
import { AuthGate } from './features/shell/AuthGate.tsx'
import { NotFound } from './features/shell/NotFound.tsx'
import { knowledgeSearch } from './lib/guide.ts'
import { parseJobsSearch } from './lib/jobs.ts'
import { type SettingsTabId, parseSettingsTab } from './lib/settings-tabs.ts'
import { type StackTab, parseStackTab } from './lib/stack.ts'
import { parseTasksSearch } from './lib/tasks.ts'
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

const ChatPage = lazyRouteComponent(() => import('./features/chat/ChatPage.tsx'), 'ChatPage')
const ReleasesPage = lazyRouteComponent(
  () => import('./features/releases/ReleasesPage.tsx'),
  'ReleasesPage',
)
const ReleaseTimelinePage = lazyRouteComponent(
  () => import('./features/releases/ReleaseTimelinePage.tsx'),
  'ReleaseTimelinePage',
)
const HomePage = lazyRouteComponent(() => import('./features/home/HomePage.tsx'), 'HomePage')
const ReposPage = lazyRouteComponent(() => import('./features/repos/ReposPage.tsx'), 'ReposPage')
const AuditsPage = lazyRouteComponent(
  () => import('./features/audits/AuditsPage.tsx'),
  'AuditsPage',
)
const AuditRunPage = lazyRouteComponent(
  () => import('./features/audits/AuditRunPage.tsx'),
  'AuditRunPage',
)
const SettingsPage = lazyRouteComponent(
  () => import('./features/settings/SettingsPage.tsx'),
  'SettingsPage',
)
const AccountPage = lazyRouteComponent(
  () => import('./features/account/AccountPage.tsx'),
  'AccountPage',
)
const BundlesPage = lazyRouteComponent(
  () => import('./features/bundles/BundlesPage.tsx'),
  'BundlesPage',
)
const DependenciesPage = lazyRouteComponent(
  () => import('./features/dependencies/DependenciesPage.tsx'),
  'DependenciesPage',
)
const CiPage = lazyRouteComponent(() => import('./features/ci/CiPage.tsx'), 'CiPage')
const CiRepoPage = lazyRouteComponent(() => import('./features/ci/CiRepoPage.tsx'), 'CiRepoPage')
const CoveragePage = lazyRouteComponent(
  () => import('./features/test-coverage/CoveragePage.tsx'),
  'CoveragePage',
)
const BranchesPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'BranchesPage',
)
const PublicApiPage = lazyRouteComponent(
  () => import('./features/public-api/PublicApiPage.tsx'),
  'PublicApiPage',
)
const LibraryPage = lazyRouteComponent(
  () => import('./features/dependencies/LibraryPage.tsx'),
  'LibraryPage',
)
const LicensesPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysesPage.tsx'),
  'LicensesPage',
)
const StackPage = lazyRouteComponent(() => import('./features/stack/StackPage.tsx'), 'StackPage')
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
const HistoryPage = lazyRouteComponent(
  () => import('./features/history/HistoryPage.tsx'),
  'HistoryPage',
)

const JobsPage = lazyRouteComponent(() => import('./features/jobs/JobsPage.tsx'), 'JobsPage')
const JobPage = lazyRouteComponent(() => import('./features/jobs/JobPage.tsx'), 'JobPage')
const TasksPage = lazyRouteComponent(() => import('./features/tasks/TasksPage.tsx'), 'TasksPage')
const AutomationPage = lazyRouteComponent(
  () => import('./features/automation/AutomationPage.tsx'),
  'AutomationPage',
)

const auditsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'audits',
  component: AuditsPage,
  validateSearch: (search: Record<string, unknown>): AuditsSearch => ({
    ...(typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {}),
    ...(search.view === 'all' ? { view: 'all' as const } : {}),
    ...(isTrigger(search.trigger) ? { trigger: search.trigger } : {}),
    ...(search.findings === 'open' || search.findings === 'clean'
      ? { findings: search.findings }
      : {}),
  }),
})

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings',
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTabId } => {
    const tab = parseSettingsTab(search.tab)
    return tab ? { tab } : {}
  },
})

const chatRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'chat',
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>): { thread?: string } =>
    typeof search.thread === 'string' && search.thread ? { thread: search.thread } : {},
})

const tabSearch = (search: Record<string, unknown>): { tab?: string } =>
  typeof search.tab === 'string' && search.tab ? { tab: search.tab } : {}

const repoRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'repos/view',
  component: RepoPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { repo?: string; tab?: string; file?: string; ref?: string } => ({
    ...(typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {}),
    ...tabSearch(search),
    ...(typeof search.file === 'string' && search.file ? { file: search.file } : {}),
    ...(typeof search.ref === 'string' && search.ref ? { ref: search.ref } : {}),
  }),
})

const groupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'repos/groups/$groupId',
  component: GroupPage,
  validateSearch: (search: Record<string, unknown>): { tab?: string; view?: StackTab } => {
    const view = parseStackTab(search.view)
    return { ...tabSearch(search), ...(view === 'runtimes' ? {} : { view }) }
  },
})

const jobsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'jobs',
  component: JobsPage,
  validateSearch: parseJobsSearch,
})

const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'tasks',
  component: TasksPage,
  validateSearch: parseTasksSearch,
})

const automationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'automation',
  component: AutomationPage,
  validateSearch: (search: Record<string, unknown>): { job?: string } =>
    typeof search.job === 'string' && search.job ? { job: search.job } : {},
})

const repoSearch = (search: Record<string, unknown>): { repo?: string } =>
  typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {}

const analysisPage = <P extends string>(
  path: P,
  component: ReturnType<typeof lazyRouteComponent>,
) => createRoute({ getParentRoute: () => appRoute, path, component, validateSearch: repoSearch })

const ciRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'ci',
  component: CiPage,
  validateSearch: repoSearch,
  beforeLoad: ({ search }) => {
    if (search.repo) throw redirect({ to: '/ci/$', params: { _splat: search.repo } })
  },
})

const bundlesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'bundles',
  component: BundlesPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { repo?: string; target?: string; version?: string; analysis?: string } =>
    Object.fromEntries(
      ['repo', 'target', 'version', 'analysis'].flatMap((key) =>
        typeof search[key] === 'string' && search[key] ? [[key, search[key]]] : [],
      ),
    ),
})

const publicApiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'public-api',
  component: PublicApiPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { package?: string; version?: string; repo?: string; tab?: string } =>
    Object.fromEntries(
      ['package', 'version', 'repo', 'tab'].flatMap((key) =>
        typeof search[key] === 'string' && search[key] ? [[key, search[key]]] : [],
      ),
    ),
})

const dependenciesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'dependencies',
  component: DependenciesPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { repo?: string; library?: string; tab?: string } =>
    Object.fromEntries(
      ['repo', 'library', 'tab'].flatMap((key) =>
        typeof search[key] === 'string' && search[key] ? [[key, search[key]]] : [],
      ),
    ),
})

const stackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'stack',
  component: StackPage,
  validateSearch: tabSearch,
})

const libraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'dependencies/$ecosystem/$',
  component: LibraryPage,
  validateSearch: tabSearch,
})

const releaseTimelineRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'releases/$',
  component: ReleaseTimelinePage,
  validateSearch: (search: Record<string, unknown>): { tab?: 'flow' } =>
    search.tab === 'flow' ? { tab: 'flow' } : {},
})

const knowledgeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'knowledge',
  component: KnowledgePage,
  validateSearch: knowledgeSearch,
})

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
    page('/', HomePage),
    page('repos', ReposPage),
    repoRoute,
    groupRoute,
    auditsRoute,
    page('audits/$runId', AuditRunPage),
    page('releases', ReleasesPage),
    releaseTimelineRoute,
    bundlesRoute,
    dependenciesRoute,
    libraryRoute,
    analysisPage('coverage', CoveragePage),
    analysisPage('branches', BranchesPage),
    ciRoute,
    page('ci/$', CiRepoPage),
    analysisPage('licenses', LicensesPage),
    stackRoute,
    publicApiRoute,
    analysisRoute,
    jobsRoute,
    page('jobs/$jobId', JobPage),
    tasksRoute,
    knowledgeRoute,
    automationRoute,
    page('history', HistoryPage),
    settingsRoute,
    page('account', AccountPage),
    chatRoute,
  ]),
])

export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

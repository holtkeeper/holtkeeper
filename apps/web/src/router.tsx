import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  retainSearchParams,
} from '@tanstack/react-router'

import { LinkPage } from './features/auth/LinkPage.tsx'
import { AuthGate } from './features/shell/AuthGate.tsx'
import { NotFound } from './features/shell/NotFound.tsx'
import { parseAnalysisSearch } from './lib/analyses.ts'
import { parseAssetsSearch } from './lib/assets.ts'
import { parseAutomationSearch } from './lib/automation.ts'
import { parseBranchesSearch } from './lib/branches.ts'
import { parseBundlesSearch } from './lib/bundles.ts'
import { parseCiSearch } from './lib/ci.ts'
import { parseCoverageSearch } from './lib/coverage.ts'
import { parseLibrariesSearch, parseLibrarySearch } from './lib/dependencies.ts'
import { type KnowledgeSearch, knowledgeSearch } from './lib/guide.ts'
import { parseInboxSearch } from './lib/inbox.ts'
import { parseJobsSearch } from './lib/jobs.ts'
import { parseLicensesSearch } from './lib/licenses.ts'
import { parsePublicApiSearch } from './lib/public-api.ts'
import { parseRepoHubSearch } from './lib/repo.ts'
import { parseReposSearch } from './lib/repos.ts'
import { parseReviewsSearch } from './lib/reviews.ts'
import { parseSecuritySearch } from './lib/security.ts'
import { parseSettingsSearch } from './lib/settings-sections.ts'
import { type StackTab, parseStackSearch, parseStackTab } from './lib/stack.ts'
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

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AuthGate,
  notFoundComponent: NotFound,
})

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
const SetupPage = lazyRouteComponent(() => import('./features/releases/SetupPage.tsx'), 'SetupPage')
const HomePage = lazyRouteComponent(() => import('./features/home/HomePage.tsx'), 'HomePage')
const InboxPage = lazyRouteComponent(() => import('./features/inbox/InboxPage.tsx'), 'InboxPage')
const ReposPage = lazyRouteComponent(() => import('./features/repos/ReposPage.tsx'), 'ReposPage')
const SecurityPage = lazyRouteComponent(
  () => import('./features/security/SecurityPage.tsx'),
  'SecurityPage',
)
const AuditRunPage = lazyRouteComponent(
  () => import('./features/security/AuditRunPage.tsx'),
  'AuditRunPage',
)
const SettingsPage = lazyRouteComponent(
  () => import('./features/settings/SettingsPage.tsx'),
  'SettingsPage',
)
const SettingsHome = lazyRouteComponent(
  () => import('./features/settings/SettingsPage.tsx'),
  'SettingsHome',
)
const AccountPage = lazyRouteComponent(
  () => import('./features/account/AccountPage.tsx'),
  'AccountPage',
)
const BundlesPage = lazyRouteComponent(
  () => import('./features/bundles/BundlesPage.tsx'),
  'BundlesPage',
)
const LibrariesPage = lazyRouteComponent(
  () => import('./features/libraries/LibrariesPage.tsx'),
  'LibrariesPage',
)
const CiPage = lazyRouteComponent(() => import('./features/ci/CiPage.tsx'), 'CiPage')
const CoveragePage = lazyRouteComponent(
  () => import('./features/test-coverage/CoveragePage.tsx'),
  'CoveragePage',
)
const BranchesPage = lazyRouteComponent(
  () => import('./features/branches/BranchesPage.tsx'),
  'BranchesPage',
)
const AssetsPage = lazyRouteComponent(
  () => import('./features/assets/AssetsPage.tsx'),
  'AssetsPage',
)
const ReviewsPage = lazyRouteComponent(
  () => import('./features/reviews/ReviewsPage.tsx'),
  'ReviewsPage',
)
const PublicApiPage = lazyRouteComponent(
  () => import('./features/public-api/PublicApiPage.tsx'),
  'PublicApiPage',
)
const LibraryPage = lazyRouteComponent(
  () => import('./features/libraries/LibraryPage.tsx'),
  'LibraryPage',
)
const LicensesPage = lazyRouteComponent(
  () => import('./features/licenses/LicensesPage.tsx'),
  'LicensesPage',
)
const StackPage = lazyRouteComponent(() => import('./features/stack/StackPage.tsx'), 'StackPage')
const AnalysisPage = lazyRouteComponent(
  () => import('./features/analyses/AnalysisPage.tsx'),
  'AnalysisPage',
)
const RepoPage = lazyRouteComponent(() => import('./features/repos/RepoPage.tsx'), 'RepoPage')
const GroupsPage = lazyRouteComponent(() => import('./features/repos/GroupsPage.tsx'), 'GroupsPage')
const GroupPage = lazyRouteComponent(() => import('./features/repos/GroupPage.tsx'), 'GroupPage')
const KnowledgePage = lazyRouteComponent(
  () => import('./features/knowledge/KnowledgePage.tsx'),
  'KnowledgePage',
)
const AiSpendPage = lazyRouteComponent(() => import('./features/ai/AiSpendPage.tsx'), 'AiSpendPage')

const JobsPage = lazyRouteComponent(() => import('./features/jobs/JobsPage.tsx'), 'JobsPage')
const JobPage = lazyRouteComponent(() => import('./features/jobs/JobPage.tsx'), 'JobPage')
const TasksPage = lazyRouteComponent(() => import('./features/tasks/TasksPage.tsx'), 'TasksPage')
const AutomationPage = lazyRouteComponent(
  () => import('./features/automation/AutomationPage.tsx'),
  'AutomationPage',
)

const securityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'supply/security',
  component: SecurityPage,
  validateSearch: parseSecuritySearch,
})

const licensesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'supply/licenses',
  component: LicensesPage,
  validateSearch: parseLicensesSearch,
})

const inboxRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'inbox',
  component: InboxPage,
  validateSearch: parseInboxSearch,
})

const chatRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'chat',
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>): { thread?: string } =>
    typeof search.thread === 'string' && search.thread ? { thread: search.thread } : {},
})

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'account',
  beforeLoad: () => {
    throw redirect({ to: '/account/$section', params: { section: 'profile' }, replace: true })
  },
})

const tabSearch = (search: Record<string, unknown>): { tab?: string } =>
  typeof search.tab === 'string' && search.tab ? { tab: search.tab } : {}

const reposLayout = createRoute({ getParentRoute: () => appRoute, path: 'repos' })

const reposRoute = createRoute({
  getParentRoute: () => reposLayout,
  path: '/',
  component: ReposPage,
  validateSearch: parseReposSearch,
})

const repoRoute = createRoute({
  getParentRoute: () => reposLayout,
  path: '$',
  component: RepoPage,
  validateSearch: parseRepoHubSearch,
})

const groupsRoute = createRoute({
  getParentRoute: () => reposLayout,
  path: 'groups',
  component: GroupsPage,
})

const groupRoute = createRoute({
  getParentRoute: () => reposLayout,
  path: 'groups/$groupId',
  component: GroupPage,
  validateSearch: (search: Record<string, unknown>): { tab?: string; view?: StackTab } => {
    const view = parseStackTab(search.view)
    return { ...tabSearch(search), ...(view === 'runtimes' ? {} : { view }) }
  },
})

const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'ops/runs',
  component: JobsPage,
  validateSearch: parseJobsSearch,
})

const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'ops/tasks',
  component: TasksPage,
  validateSearch: parseTasksSearch,
})

const automationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'ops/automation',
  component: AutomationPage,
  validateSearch: parseAutomationSearch,
})

const releasesPage = <P extends string>(
  path: P,
  component: ReturnType<typeof lazyRouteComponent>,
) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component,
    validateSearch: (search: Record<string, unknown>): { repo?: string } =>
      typeof search.repo === 'string' && search.repo ? { repo: search.repo } : {},
  })

const coverageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'quality/coverage',
  component: CoveragePage,
  validateSearch: parseCoverageSearch,
})

const bundlesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'quality/bundles',
  component: BundlesPage,
  validateSearch: parseBundlesSearch,
})

const assetsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'quality/assets',
  component: AssetsPage,
  validateSearch: parseAssetsSearch,
})

const ciRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'quality/ci',
  component: CiPage,
  validateSearch: parseCiSearch,
})

const branchesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'quality/branches',
  component: BranchesPage,
  validateSearch: parseBranchesSearch,
})

const reviewsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'quality/reviews',
  component: ReviewsPage,
  validateSearch: parseReviewsSearch,
})

const publicApiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'supply/public-api',
  component: PublicApiPage,
  validateSearch: parsePublicApiSearch,
})

const librariesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'supply/libraries',
  component: LibrariesPage,
  validateSearch: parseLibrariesSearch,
})

const stackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'supply/stack',
  component: StackPage,
  validateSearch: parseStackSearch,
})

const libraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'supply/libraries/$ecosystem/$',
  component: LibraryPage,
  validateSearch: parseLibrarySearch,
})

const settingsSectionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings/$section',
  component: SettingsPage,
  validateSearch: parseSettingsSearch,
})

const knowledgePage = <P extends string>(path: P) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component: KnowledgePage,
    validateSearch: knowledgeSearch,
    search: { middlewares: [retainSearchParams<KnowledgeSearch>(['space'])] },
  })

const analysisRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'analyses/$id',
  component: AnalysisPage,
  validateSearch: parseAnalysisSearch,
})

const routeTree = rootRoute.addChildren([
  linkRoute,
  appRoute.addChildren([
    page('/', HomePage),
    inboxRoute,
    reposLayout.addChildren([reposRoute, groupsRoute, groupRoute, repoRoute]),
    chatRoute,
    librariesRoute,
    libraryRoute,
    securityRoute,
    page('supply/security/runs/$runId', AuditRunPage),
    licensesRoute,
    stackRoute,
    publicApiRoute,
    coverageRoute,
    bundlesRoute,
    assetsRoute,
    ciRoute,
    branchesRoute,
    reviewsRoute,
    page('releases', ReleasesPage),
    releasesPage('releases/timeline', ReleaseTimelinePage),
    releasesPage('releases/setup', SetupPage),
    knowledgePage('knowledge/guide'),
    knowledgePage('knowledge/notes'),
    knowledgePage('knowledge/learnings'),
    runsRoute,
    page('ops/runs/$jobId', JobPage),
    tasksRoute,
    automationRoute,
    page('ops/spend', AiSpendPage),
    page('settings', SettingsHome),
    settingsSectionRoute,
    accountRoute,
    page('account/$section', AccountPage),
    analysisRoute,
  ]),
])

export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

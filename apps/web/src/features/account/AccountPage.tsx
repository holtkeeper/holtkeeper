import { Link, useParams } from '@tanstack/react-router'
import {
  BookText,
  Bot,
  Fingerprint,
  Link2,
  LogOut,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { type ComponentType, type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useAccount,
  useAccounts,
  useAuthMutations,
  useMcpTokens,
  usePreferences,
} from '../../api/queries.ts'
import { roleLabel, visibleSettingsSections } from '../../lib/access.ts'
import {
  type AccountSectionId,
  accountSections,
  parseAccountSection,
  visibleAccountSections,
} from '../../lib/account-sections.ts'
import { formatDate } from '../../lib/format.ts'
import { tokenStatusCounts } from '../../lib/mcp-tokens.ts'
import {
  Avatar,
  Button,
  Crumbs,
  SubNav,
  type SubNavItem,
  Tag,
  buttonClass,
  notify,
} from '../../ui/index.ts'
import { McpServer } from '../mcp/McpServer.tsx'
import { docsUrl } from '../shell/nav.ts'
import { NotFound } from '../shell/NotFound.tsx'
import { useSession } from '../shell/session.ts'
import { ExternalAccounts } from './ExternalAccounts.tsx'
import { HomeGroups } from './HomeGroups.tsx'
import { MyAccess } from './MyAccess.tsx'
import { Passkeys } from './Passkeys.tsx'
import { Preferences } from './Preferences.tsx'
import { Profile } from './Profile.tsx'

const icons: Record<AccountSectionId, ComponentType<{ className?: string }>> = {
  profile: UserRound,
  teams: UsersRound,
  'sign-in': Fingerprint,
  linked: Link2,
  access: ShieldCheck,
  agents: Bot,
  preferences: SlidersHorizontal,
}

/** What the header's primary action hands to the section body. */
interface BodyProps {
  creating?: boolean
  onCreating?: (open: boolean) => void
}

const bodies: Record<AccountSectionId, ComponentType<BodyProps>> = {
  profile: Profile,
  teams: HomeGroups,
  'sign-in': Passkeys,
  linked: ExternalAccounts,
  access: MyAccess,
  agents: McpServer,
  preferences: Preferences,
}

/** What the users provider adds to the header: passkeys and single sign-on, member since. */
interface UserFacts {
  passkeys: number
  identities: readonly string[]
  createdAt: string
}

function SignOut() {
  const { auth } = useSession()
  const { logout } = useAuthMutations()
  if (!auth.logoutUrl) return null
  const url = auth.logoutUrl
  return (
    <Button
      variant="secondary"
      size="sm"
      isPending={logout.isPending}
      onPress={() =>
        logout.mutate(url, {
          onError: (error) => notify.error('Sign-out failed', messageOf(error)),
        })
      }
    >
      <LogOut className="size-3.5" />
      Sign out
    </Button>
  )
}

function Header({
  section,
  user,
  onNewToken,
}: {
  section: AccountSectionId
  user: UserFacts | undefined
  onNewToken: () => void
}) {
  const { principal } = useSession()
  const tokens = useMcpTokens()
  const chips: ReactNode[] = [
    <Tag key="role" tone="accent">
      {roleLabel(principal.grants)}
    </Tag>,
    ...(user
      ? [
          ...user.identities.map((provider) => (
            <Tag key={`sso:${provider}`}>
              Single sign-on · <span className="mono">{provider}</span>
            </Tag>
          )),
          user.passkeys ? (
            <Tag key="passkey">{user.passkeys === 1 ? 'Passkey' : `${user.passkeys} passkeys`}</Tag>
          ) : null,
        ]
      : [
          <Tag key="provider">
            Signed in via <span className="mono">{principal.provider}</span>
          </Tag>,
        ]),
  ]
  return (
    <header className="flex flex-col gap-2.5 border-b border-line px-3.5 py-3">
      <Crumbs
        items={[
          { label: 'Account', link: { to: '/account/$section', params: { section: 'profile' } } },
          { label: accountSections[section].label },
        ]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Avatar
          key={principal.avatarUrl}
          src={principal.avatarUrl}
          name={principal.name}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold leading-tight">{principal.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {principal.email ? <span>{principal.email}</span> : null}
            {chips}
            {user ? <span>Member since {formatDate(user.createdAt)}</span> : null}
          </div>
        </div>
        <a href={docsUrl} target="_blank" rel="noreferrer" className={buttonClass('ghost', 'sm')}>
          <BookText className="size-3.5" />
          Docs
        </a>
        <SignOut />
        {section === 'agents' && tokens.data?.available ? (
          <Button variant="primary" size="sm" onPress={onNewToken}>
            <Plus className="size-3.5" />
            New token
          </Button>
        ) : null}
      </div>
    </header>
  )
}

function Nav({ section, passkeys }: { section: AccountSectionId; passkeys: number | undefined }) {
  const { principal, auth } = useSession()
  const preferences = usePreferences()
  const accounts = useAccounts()
  const tokens = useMcpTokens()
  const unverified = accounts.data?.accounts.filter((a) => a.verification === 'unverified').length
  const live = tokens.data?.available
    ? tokens.data.tokens.length - tokenStatusCounts(tokens.data.tokens).expired
    : undefined
  const meta: Partial<Record<AccountSectionId, ReactNode>> = {
    teams: preferences.data?.homeGroups.length || undefined,
    'sign-in':
      passkeys === undefined ? undefined : `${passkeys} passkey${passkeys === 1 ? '' : 's'}`,
    linked: unverified ? `${unverified} to verify` : undefined,
    access: roleLabel(principal.grants),
    agents: live === undefined ? undefined : `${live} active`,
  }
  const items: SubNavItem[] = visibleAccountSections(auth.provider).map((id) => ({
    id,
    label: accountSections[id].label,
    icon: icons[id],
    link: { to: '/account/$section', params: { section: id } },
    meta: meta[id],
  }))
  const [settings] = visibleSettingsSections(principal)
  return (
    <SubNav
      aria-label="Account sections"
      items={items}
      selected={section}
      {...(settings
        ? {
            footer: (
              <>
                <span>Admin work lives in Settings.</span>
                <Link
                  to="/settings/$section"
                  params={{ section: settings }}
                  className="text-muted hover:text-foreground"
                >
                  Open Settings
                </Link>
              </>
            ),
          }
        : {})}
    />
  )
}

function Layout({ section, user }: { section: AccountSectionId; user: UserFacts | undefined }) {
  const Body = bodies[section]
  const { label, description } = accountSections[section]
  const [creating, setCreating] = useState(false)
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header section={section} user={user} onNewToken={() => setCreating(true)} />
      <div className="flex min-w-0 flex-1 flex-col md:flex-row">
        <Nav section={section} passkeys={user?.passkeys} />
        <section
          aria-labelledby="account-section"
          className="flex min-w-0 flex-1 flex-col gap-4 p-4"
        >
          <div>
            <h2 id="account-section" className="text-[14px] font-semibold">
              {label}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{description}</p>
          </div>
          <Body creating={creating} onCreating={setCreating} />
        </section>
      </div>
    </div>
  )
}

function UsersLayout({ section }: { section: AccountSectionId }) {
  const account = useAccount()
  const user = account.data
    ? {
        passkeys: account.data.passkeys.length,
        identities: account.data.identities.map((identity) => identity.provider),
        createdAt: account.data.createdAt,
      }
    : undefined
  return <Layout section={section} user={user} />
}

/**
 * `/account/$section`: the signed-in principal's own account for every auth provider. A header
 * with role, sign-in chips, Docs and Sign out, a left `SubNav` and the section: Profile, My teams,
 * Sign-in (passkeys, `users` provider only), Linked accounts, My access, Connect agents and
 * Preferences. Only the `users` provider triggers `/auth/users/*` requests.
 */
export function AccountPage() {
  const { auth } = useSession()
  const params = useParams({ from: '/app/account/$section' })
  const section = parseAccountSection(params.section)
  if (!section || !visibleAccountSections(auth.provider).includes(section)) return <NotFound />
  return auth.provider === 'users' ? (
    <UsersLayout section={section} />
  ) : (
    <Layout section={section} user={undefined} />
  )
}

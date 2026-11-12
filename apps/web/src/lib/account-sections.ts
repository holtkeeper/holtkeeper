/** The sections of `/account/$section`, in sub-navigation order. */
const accountSectionIds = [
  'profile',
  'teams',
  'sign-in',
  'linked',
  'access',
  'agents',
  'preferences',
] as const

/** One section of the Account page. */
export type AccountSectionId = (typeof accountSectionIds)[number]

/** Title and one-line purpose of each Account section. */
export const accountSections: Readonly<
  Record<AccountSectionId, { label: string; description: string }>
> = {
  profile: { label: 'Profile', description: 'Your name, email and avatar' },
  teams: {
    label: 'My teams',
    description: 'What “My teams” shows on every list page. A default view, not a permission.',
  },
  'sign-in': {
    label: 'Sign-in',
    description:
      'Each passkey signs you in on its own. Keep a second one in case you lose a device.',
  },
  linked: {
    label: 'Linked accounts',
    description:
      'Your accounts on forges and chat, so bots and merge request commands act as you once a link is verified',
  },
  access: { label: 'My access', description: 'What your grants let you do, and where' },
  agents: {
    label: 'Connect agents',
    description:
      'Give AI agents access to your packages and the libraries you use through the MCP server. Tokens read by default and act as you.',
  },
  preferences: { label: 'Preferences', description: 'Theme and where list pages open' },
}

/** A section id from the address; `undefined` for anything else. */
export const parseAccountSection = (value: unknown): AccountSectionId | undefined =>
  accountSectionIds.find((id) => id === value)

/** The sections a provider offers: passkeys (Sign-in) exist only with the `users` provider. */
export const visibleAccountSections = (provider: string): AccountSectionId[] =>
  accountSectionIds.filter((id) => id !== 'sign-in' || provider === 'users')

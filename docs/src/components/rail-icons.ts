/** Stroke paths (24×24) of the panel's rail and settings icons, keyed by the workspace they mark. */
export const railIcons = {
  home: ['M4 10.5L12 4l8 6.5V20h-5v-6h-6v6H4z'],
  repos: [
    'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  ],
  chat: ['M4 5h16v11H9l-5 4z'],
  supply: ['M21 7.5l-9-4.5-9 4.5v9l9 4.5 9-4.5z', 'M3 7.5l9 4.5 9-4.5M12 12v9'],
  quality: ['M4 19V9M10 19V5M16 19v-7M21 19H3'],
  releases: [
    'M6 3a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM6 17a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM18 7a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
    'M6 7v10M18 11c0 4-4 5-10 6.5',
  ],
  knowledge: [
    'M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z',
  ],
  ops: [
    'M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
    'M12 4v4M9 13v1M15 13v1',
  ],
  settings: [
    'M4 7h9M17 7h3M4 17h3M11 17h9',
    'M15 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM9 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  ],
  account: ['M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6'],
  start: ['M5 12h14M13 6l6 6-6 6'],
  agents: ['M8 7l-5 5 5 5M16 7l5 5-5 5'],
  server: [
    'M5 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM5 13h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z',
    'M7 7.5h.01M7 16.5h.01',
  ],
  book: ['M5 4h14v16H5zM9 8h6M9 12h6M9 16h3'],
} as const

export type RailIconName = keyof typeof railIcons

/** The rail icon of a sidebar group, by its label. */
export const groupRailIcon: Record<string, RailIconName> = {
  Home: 'home',
  Repos: 'repos',
  Chat: 'chat',
  'Supply chain': 'supply',
  Quality: 'quality',
  Releases: 'releases',
  Knowledge: 'knowledge',
  Ops: 'ops',
  Settings: 'settings',
  Account: 'account',
  Concepts: 'book',
  'First steps': 'start',
  'Connect an agent': 'agents',
  'Get running': 'server',
  Configure: 'settings',
  Operate: 'ops',
}

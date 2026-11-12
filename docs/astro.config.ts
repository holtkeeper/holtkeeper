import { fileURLToPath } from 'node:url'

import starlight from '@astrojs/starlight'
import mermaid from 'astro-mermaid'
import { defineConfig } from 'astro/config'
import starlightSidebarTopics from 'starlight-sidebar-topics'

import { repositoryLinks } from './src/docs/links.ts'
import { createLinkResolver, developSidebar, discoverDocs, repoUrl } from './src/docs/sources.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const sources = discoverDocs(root)
const develop = developSidebar(sources)

const group = (label: string, directory: string, collapsed = false) => ({
  label,
  collapsed,
  items: [{ autogenerate: { directory } }],
})

export default defineConfig({
  site: 'https://holtkeeper.github.io',
  outDir: './dist',
  vite: {
    resolve: {
      alias: { '@ui': fileURLToPath(new URL('./src/components/ui/index.ts', import.meta.url)) },
    },
  },
  integrations: [
    mermaid({
      theme: 'base',
      autoTheme: false,
      enableLog: false,
      mermaidConfig: {
        fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
        flowchart: { curve: 'basis', padding: 14, nodeSpacing: 36, rankSpacing: 52 },
        themeVariables: {
          darkMode: true,
          fontSize: '14px',
          background: '#0b0b0c',
          mainBkg: '#18181b',
          primaryColor: '#18181b',
          primaryTextColor: '#ededef',
          primaryBorderColor: '#3a3a40',
          nodeBorder: '#3a3a40',
          secondaryColor: '#111113',
          tertiaryColor: '#0e0e10',
          textColor: '#b4b4bb',
          lineColor: '#f0a63a',
          clusterBkg: '#0e0e10',
          clusterBorder: '#2a2a2e',
          titleColor: '#9a9aa2',
          edgeLabelBackground: '#0b0b0c',
          actorBkg: '#18181b',
          actorBorder: '#3a3a40',
          actorTextColor: '#ededef',
          actorLineColor: '#2a2a2e',
          signalColor: '#f0a63a',
          signalTextColor: '#b4b4bb',
          noteBkgColor: '#111113',
          noteBorderColor: '#2a2a2e',
          noteTextColor: '#b4b4bb',
          dropShadow: 'none',
        },
      },
    }),
    starlight({
      title: 'Holtkeeper',
      description:
        'A cozy holt for every repository: self-hosted AI review, dependency waves, audits and releases for fleets of GitLab repositories, from a homelab to a production zoo.',
      logo: { src: '@holtkeeper/brand/holtkeeper.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repoUrl }],
      editLink: { baseUrl: `${repoUrl}/edit/main/docs/` },
      markdown: { processedDirs: ['.', '../apps', '../packages', '../plugins'] },
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/geist-mono',
        './src/styles/theme.css',
        './src/styles/ui.css',
      ],
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700;0,900;1,400&display=swap',
          },
        },
      ],
      components: {
        Header: './src/components/overrides/Header.astro',
        PageTitle: './src/components/overrides/PageTitle.astro',
        Sidebar: './src/components/overrides/Sidebar.astro',
        ThemeProvider: './src/components/overrides/ThemeProvider.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          borderRadius: '0.6rem',
          borderColor: 'var(--hk-code-border)',
          codeFontFamily: '"Geist Mono Variable", ui-monospace, monospace',
          codeFontSize: '0.8125rem',
          uiFontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
          frames: { shadowColor: 'transparent' },
        },
      },
      plugins: [
        starlightSidebarTopics([
          {
            id: 'start',
            label: 'Start',
            link: '/start/',
            icon: 'rocket',
            items: [
              'start',
              'start/quickstart',
              group('Concepts', 'start/concepts'),
              group('First steps', 'start/first-steps'),
            ],
          },
          {
            id: 'guide',
            label: 'Guide',
            link: '/guide/',
            icon: 'open-book',
            items: [
              'guide',
              group('Home', 'guide/home'),
              group('Repos', 'guide/repos', true),
              group('Chat', 'guide/chat', true),
              group('Supply chain', 'guide/supply-chain', true),
              group('Quality', 'guide/quality', true),
              group('Releases', 'guide/releases', true),
              group('Knowledge', 'guide/knowledge', true),
              group('Ops', 'guide/ops', true),
              group('Settings', 'guide/settings', true),
              group('Account', 'guide/account', true),
            ],
          },
          {
            id: 'agents',
            label: 'Agents',
            link: '/agents/',
            icon: 'seti:json',
            items: [{ autogenerate: { directory: 'agents' } }, 'agents/library-docs'],
          },
          {
            id: 'self-host',
            label: 'Self-host',
            link: '/self-host/',
            icon: 'laptop',
            items: [
              'self-host',
              group('Get running', 'self-host/run'),
              group('Configure', 'self-host/configure'),
              group('Operate', 'self-host/operate'),
              { label: 'Reference', collapsed: true, items: ['self-host/reference/deployment'] },
            ],
          },
          {
            id: 'develop',
            label: 'Develop',
            link: '/develop/',
            icon: 'puzzle',
            items: [
              'develop',
              { label: 'Project', items: ['develop/architecture', ...develop.project] },
              { label: 'Modules', items: develop.modules },
            ],
          },
          {
            id: 'reference',
            label: 'Reference',
            link: '/reference/',
            icon: 'document',
            items: [{ autogenerate: { directory: 'reference' } }],
          },
        ]),
      ],
    }),
    repositoryLinks(createLinkResolver(root, sources)),
  ],
})

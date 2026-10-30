import { fileURLToPath } from 'node:url'

import react from '@astrojs/react'
import starlight from '@astrojs/starlight'
import tailwindcss from '@tailwindcss/vite'
import mermaid from 'astro-mermaid'
import { defineConfig } from 'astro/config'
import starlightSidebarTopics from 'starlight-sidebar-topics'

import { repositoryLinks } from './src/docs/links.ts'
import { createLinkResolver, discoverDocs, repoUrl, sidebarTopics } from './src/docs/sources.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const sources = discoverDocs(root)
const sidebar = sidebarTopics(sources)

export default defineConfig({
  site: 'https://holtkeeper.github.io',
  outDir: './dist',
  vite: { plugins: [tailwindcss()] },
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
          background: '#0b0a08',
          mainBkg: '#16130e',
          primaryColor: '#16130e',
          primaryTextColor: '#f1ece2',
          primaryBorderColor: '#6b4f1d',
          nodeBorder: '#6b4f1d',
          secondaryColor: '#12100c',
          tertiaryColor: '#0f0d0a',
          textColor: '#cfc8ba',
          lineColor: '#b8862f',
          clusterBkg: '#0f0d0a',
          clusterBorder: '#2e2a22',
          titleColor: '#a19a8c',
          edgeLabelBackground: '#0b0a08',
          actorBkg: '#16130e',
          actorBorder: '#6b4f1d',
          actorTextColor: '#f1ece2',
          actorLineColor: '#2e2a22',
          signalColor: '#b8862f',
          signalTextColor: '#cfc8ba',
          noteBkgColor: '#12100c',
          noteBorderColor: '#2e2a22',
          noteTextColor: '#cfc8ba',
          dropShadow: 'none',
        },
      },
    }),
    react(),
    starlight({
      title: 'Holtkeeper',
      description:
        'Self-hosted automation engine for fleets of GitLab and GitHub repositories: AI code review, dependency waves, audits and releases.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repoUrl }],
      editLink: { baseUrl: `${repoUrl}/edit/main/docs/` },
      markdown: { processedDirs: ['.', '../apps', '../packages', '../plugins'] },
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/geist-mono',
        './src/styles/theme.css',
      ],
      components: {
        PageTitle: './src/components/overrides/PageTitle.astro',
        Sidebar: './src/components/overrides/Sidebar.astro',
        ThemeProvider: './src/components/overrides/ThemeProvider.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          borderRadius: '0.75rem',
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
            label: 'Guide',
            link: '/guide/getting-started/',
            icon: 'open-book',
            items: sidebar.guide,
          },
          {
            label: 'Modules',
            link: '/modules/',
            icon: 'puzzle',
            items: sidebar.modules,
          },
        ]),
      ],
    }),
    repositoryLinks(createLinkResolver(root, sources)),
  ],
})

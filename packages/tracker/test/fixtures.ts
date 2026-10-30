import type { ListFilesOptions, RepoRef, TreeEntry } from '@holtkeeper/forge'

import type {
  DocumentContent,
  DocumentSink,
  DocumentSource,
  SectionInput,
} from '../src/contracts.ts'
import { DocumentVersionConflictError } from '../src/contracts.ts'
import type { TrackerDefinitionInput } from '../src/definition.ts'
import type { TrackerForge } from '../src/sources/types.ts'

/** A forge over in-memory files: repo path → file path → content. */
export function fakeForge(
  files: Record<string, Record<string, string>>,
): TrackerForge & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async readFile(repo: string, file: string) {
      reads.push(`${repo}/${file}`)
      return files[repo]?.[file]
    },
    async listFiles(repo: string, options: ListFilesOptions = {}): Promise<TreeEntry[]> {
      const base = options.path ? `${options.path.replace(/\/+$/, '')}/` : ''
      const entries = new Map<string, TreeEntry>()
      for (const path of Object.keys(files[repo] ?? {})) {
        if (!path.startsWith(base)) continue
        const segments = path.slice(base.length).split('/')
        const depth = options.recursive ? segments.length : 1
        for (let index = 1; index <= depth; index++) {
          const entry = base + segments.slice(0, index).join('/')
          entries.set(entry, { path: entry, type: index === segments.length ? 'file' : 'dir' })
        }
      }
      return [...entries.values()]
    },
  }
}

export const gameRepos: RepoRef[] = ['games/app', 'games/adventure', 'games/puzzle'].map(
  (path) => ({
    forge: 'work',
    path,
  }),
)

const flagsJson = (flags: Record<string, { default: boolean; description?: string }>) =>
  JSON.stringify(
    { flags: Object.entries(flags).map(([name, flag]) => ({ name, ...flag })) },
    null,
    2,
  )

/** Three game repositories, a Helm repository and nothing else. */
export const forgeFiles: Record<string, Record<string, string>> = {
  'games/app': {
    'src/flags.json': flagsJson({
      new_hub: { default: false, description: 'Redesigned hub' },
      turbo_mode: { default: true },
    }),
    'src/hub.ts': 'if (isEnabled(\'new_hub\')) showHub()\nconst turbo = isEnabled("turbo_mode")\n',
  },
  'games/adventure': {
    'src/flags.json': flagsJson({ new_hub: { default: false }, old_tables: { default: true } }),
    'src/board.tsx':
      "export const T = () => (isEnabled('new_hub') ? <Hub /> : null)\nisEnabled('ghost_flag')\n",
  },
  'games/puzzle': {
    'src/app.ts': 'console.log("no flags")\n',
  },
  'infra/helm': {
    'charts/app/values-dev.yaml': 'featureFlags:\n  new_hub: true\n  turbo_mode: true\n',
    'charts/app/values-prod.yaml':
      'featureFlags:\n  new_hub: false\n  turbo_mode: false\n  removed_flag: true\n',
    'charts/adventure/values-prod.yaml': 'featureFlags:\n  new_hub: false\n',
    'charts/adventure/Chart.yaml': 'name: adventure\n',
    'docs/flags.md': 'old\n',
  },
}

/** The Confluence page of the motivating case, in storage format. */
export const flagsPage: DocumentContent = {
  ref: '12345',
  title: 'Feature flags',
  version: 7,
  url: 'https://wiki.example.com/pages/12345',
  format: 'storage',
  body: [
    '<h1>Feature flags</h1><p>Owned by the platform team.</p>',
    '<h2>Flags</h2>',
    '<table><tbody>',
    '<tr><th>Flag</th><th>Description</th><th>Owner</th></tr>',
    '<tr><td><code>new_hub</code></td><td>New &amp; shiny hub</td><td><ac:link><ri:user ri:account-id="abc" /></ac:link></td></tr>',
    '<tr><td>legacy_widget</td><td>Old extra level</td><td>Games</td></tr>',
    '</tbody></table>',
    '<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">holtkeeper:flags</ac:parameter></ac:structured-macro>',
  ].join(''),
}

export function fakeDocuments(pages: DocumentContent[]): DocumentSource & { reads: string[] } {
  const reads: string[] = []
  return {
    provider: 'confluence',
    reads,
    async read(ref: string) {
      reads.push(ref)
      const page = pages.find((candidate) => candidate.ref === ref)
      if (!page) throw new Error(`page ${ref} not found`)
      return page
    },
  }
}

/** A sink keeping sections in memory, rejecting stale `expectedVersion`s like Confluence would. */
export function fakeSink(
  version = 7,
): DocumentSink & { writes: { ref: string; input: SectionInput }[]; version: number } {
  const sections = new Map<string, string>()
  const sink = {
    provider: 'confluence',
    version,
    writes: [] as { ref: string; input: SectionInput }[],
    async replaceSection(ref: string, input: SectionInput) {
      if (input.expectedVersion !== undefined && input.expectedVersion !== sink.version)
        throw new DocumentVersionConflictError('page was edited', {
          expected: input.expectedVersion,
          actual: sink.version,
        })
      const key = `${ref}#${input.markerId}`
      if (sections.get(key) === input.content)
        return {
          version: sink.version,
          url: `https://wiki.example.com/pages/${ref}`,
          changed: false,
        }
      sections.set(key, input.content)
      sink.writes.push({ ref, input })
      sink.version++
      return { version: sink.version, url: `https://wiki.example.com/pages/${ref}`, changed: true }
    },
  }
  return sink
}

/** The feature-flag tracker of the motivating case (also in docs/README.md). */
export const featureFlags: TrackerDefinitionInput = {
  id: 'feature-flags',
  name: 'Feature flags',
  entity: { label: 'Feature flag', key: { normalize: ['snake'] } },
  sources: [
    {
      kind: 'files',
      id: 'definitions',
      role: 'definition',
      repos: ['games/*'],
      paths: ['src/flags.json'],
      extract: {
        kind: 'json-path',
        path: '$.flags[*]',
        key: '$.name',
        attrs: { default: '$.default', description: '$.description' },
      },
    },
    {
      kind: 'files',
      id: 'usages',
      role: 'usage',
      repos: ['games/*'],
      paths: ['src/**/*.{ts,tsx}'],
      extract: { kind: 'ast-grep', pattern: 'isEnabled($KEY)' },
    },
    {
      kind: 'files',
      id: 'helm',
      role: 'config',
      repos: ['infra/helm'],
      paths: ['charts/*/values-*.yaml'],
      extract: { kind: 'yaml-path', path: '$.featureFlags.*' },
      environment: { fromPath: 'values-(?<env>[a-z]+)\\.yaml$' },
    },
    {
      kind: 'document',
      id: 'wiki',
      role: 'documentation',
      provider: 'confluence',
      ref: '12345',
      extract: {
        kind: 'table',
        heading: 'Flags',
        keyColumn: 'Flag',
        columns: { description: 'Description', owner: 'Owner' },
      },
    },
  ],
  rules: [
    { kind: 'unused' },
    { kind: 'undefined', roles: ['usage'] },
    { kind: 'stale-config' },
    { kind: 'undocumented' },
    { kind: 'documented-missing' },
    {
      kind: 'attribute-mismatch',
      attr: 'default',
      against: { role: 'config', attr: 'value' },
      environments: ['prod'],
    },
    { kind: 'naming', pattern: '^[a-z][a-z0-9_]*$' },
  ],
  outputs: [
    {
      kind: 'document-section',
      id: 'wiki-section',
      provider: 'confluence',
      ref: '12345',
      markerId: 'holtkeeper:flags',
      template: {
        title: 'Flag inventory',
        columns: [
          { header: 'Flag', value: 'key' },
          { header: 'Description', value: 'description' },
          { header: 'Owner', value: 'owner' },
          { header: 'Repositories', value: 'usedIn' },
          { header: 'prod', value: 'env:prod' },
        ],
      },
    },
    {
      kind: 'repo-file',
      id: 'helm-doc',
      repo: 'infra/helm',
      path: 'docs/flags.md',
      template: { title: 'Feature flags', findings: true },
    },
    { kind: 'notify', id: 'chat' },
  ],
}

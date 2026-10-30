import type { ComponentKind } from './types.ts'

/** Where a component's latest version and lifecycle come from. */
export type Lookup =
  | { type: 'endoflife'; product: string }
  | { type: 'npm'; name: string }
  | { type: 'pypi'; name: string }
  /** Tags of the image a usage names, or of `registry/repository` when given. */
  | { type: 'image'; registry?: string; repository?: string }
  | { type: 'none' }

/** What the analysis knows about a component. */
export interface ComponentInfo {
  id: string
  name: string
  kind: ComponentKind
  lookup: Lookup
}

const endoflife = (product: string): Lookup => ({ type: 'endoflife', product })
const npm = (name: string): Lookup => ({ type: 'npm', name })
const pypi = (name: string): Lookup => ({ type: 'pypi', name })

const tools: Record<string, Omit<ComponentInfo, 'id' | 'name'> & { name?: string }> = {
  node: { name: 'Node.js', kind: 'runtime', lookup: endoflife('nodejs') },
  go: { name: 'Go', kind: 'runtime', lookup: endoflife('go') },
  python: { name: 'Python', kind: 'runtime', lookup: endoflife('python') },
  ruby: { name: 'Ruby', kind: 'runtime', lookup: endoflife('ruby') },
  php: { name: 'PHP', kind: 'runtime', lookup: endoflife('php') },
  java: { name: 'Java', kind: 'runtime', lookup: endoflife('eclipse-temurin') },
  rust: { name: 'Rust', kind: 'runtime', lookup: endoflife('rust') },
  deno: {
    name: 'Deno',
    kind: 'runtime',
    lookup: { type: 'image', registry: 'docker.io', repository: 'denoland/deno' },
  },
  bun: { name: 'Bun', kind: 'runtime', lookup: npm('bun') },
  npm: { kind: 'package-manager', lookup: npm('npm') },
  pnpm: { kind: 'package-manager', lookup: npm('pnpm') },
  yarn: { name: 'Yarn', kind: 'package-manager', lookup: npm('@yarnpkg/cli-dist') },
  poetry: { name: 'Poetry', kind: 'package-manager', lookup: pypi('poetry') },
  uv: { kind: 'package-manager', lookup: pypi('uv') },
  postgres: { name: 'PostgreSQL', kind: 'service', lookup: endoflife('postgresql') },
  mysql: { name: 'MySQL', kind: 'service', lookup: endoflife('mysql') },
  mariadb: { name: 'MariaDB', kind: 'service', lookup: endoflife('mariadb') },
  mongodb: { name: 'MongoDB', kind: 'service', lookup: endoflife('mongodb') },
  redis: { name: 'Redis', kind: 'service', lookup: endoflife('redis') },
  valkey: { name: 'Valkey', kind: 'service', lookup: endoflife('valkey') },
  nginx: { kind: 'service', lookup: endoflife('nginx') },
  rabbitmq: { name: 'RabbitMQ', kind: 'service', lookup: endoflife('rabbitmq') },
  elasticsearch: { name: 'Elasticsearch', kind: 'service', lookup: endoflife('elasticsearch') },
  haproxy: { name: 'HAProxy', kind: 'service', lookup: endoflife('haproxy') },
  traefik: { name: 'Traefik', kind: 'service', lookup: endoflife('traefik') },
  docker: { name: 'Docker', kind: 'tool', lookup: endoflife('docker-engine') },
  alpine: { name: 'Alpine', kind: 'os', lookup: endoflife('alpine') },
  debian: { name: 'Debian', kind: 'os', lookup: endoflife('debian') },
  ubuntu: { name: 'Ubuntu', kind: 'os', lookup: endoflife('ubuntu') },
}

/** Docker Hub images (without `library/`) that are a known component. */
const imageAliases: Record<string, string> = {
  node: 'node',
  golang: 'go',
  python: 'python',
  ruby: 'ruby',
  php: 'php',
  'eclipse-temurin': 'java',
  rust: 'rust',
  'oven/bun': 'bun',
  'denoland/deno': 'deno',
  postgres: 'postgres',
  'postgis/postgis': 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mongo: 'mongodb',
  redis: 'redis',
  'valkey/valkey': 'valkey',
  nginx: 'nginx',
  'nginxinc/nginx-unprivileged': 'nginx',
  rabbitmq: 'rabbitmq',
  elasticsearch: 'elasticsearch',
  haproxy: 'haproxy',
  traefik: 'traefik',
  docker: 'docker',
  alpine: 'alpine',
  debian: 'debian',
  ubuntu: 'ubuntu',
}

/** Images other registries publish under a known component. */
const mirroredImages: Record<string, string> = {
  'mcr.microsoft.com/devcontainers/javascript-node': 'node',
  'public.ecr.aws/docker/library/node': 'node',
  'gcr.io/distroless/nodejs': 'node',
  'cgr.dev/chainguard/node': 'node',
}

/** The component a mise tool name stands for; unknown tools are `tool` components without lookups. */
export function toolComponent(tool: string): ComponentInfo {
  const known = tools[tool]
  return known
    ? { id: tool, name: known.name ?? tool, kind: known.kind, lookup: known.lookup }
    : { id: tool, name: tool, kind: 'tool', lookup: { type: 'none' } }
}

/**
 * The component an image stands for: a known runtime, service or OS by its official image, else an
 * `image` component of its own whose latest version comes from the registry's tags.
 */
export function imageComponent(image: { registry: string; repository: string }): ComponentInfo {
  const hub = image.registry === 'docker.io'
  const short = hub ? image.repository.replace(/^library\//, '') : image.repository
  const alias = hub ? imageAliases[short] : mirroredImages[`${image.registry}/${image.repository}`]
  if (alias) return toolComponent(alias)
  const name = hub ? short : `${image.registry}/${image.repository}`
  return { id: `image:${name}`, name, kind: 'image', lookup: { type: 'image' } }
}

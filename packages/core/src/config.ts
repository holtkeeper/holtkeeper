import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { AuthProvider } from '@holtkeeper/auth'
import type { ForgeDefinition, Secret } from '@holtkeeper/forge'
import type { Store } from '@holtkeeper/store'
import { z } from 'zod'

import type { PluginUse } from './plugin.ts'

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, 'use lowercase letters, digits and dashes')

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const forgeSchema = z.custom<ForgeDefinition>(
  (value) => isObject(value) && typeof value.create === 'function',
  'expected a forge, e.g. gitlab({ ... })',
)

const pluginUseSchema = z.custom<PluginUse>(
  (value) => isObject(value) && isObject(value.plugin) && typeof value.plugin.run === 'function',
  'expected a plugin, e.g. browserslist({ ... })',
)

const authSchema = z.custom<AuthProvider>(
  (value) =>
    isObject(value) && typeof value.authenticate === 'function' && typeof value.info === 'function',
  'expected an auth provider, e.g. noAuth() or passwordAuth({ ... })',
)

const storeSchema = z.custom<Store>(
  (value) => isObject(value) && isObject(value.auditRuns) && typeof value.close === 'function',
  'expected a store, e.g. sqliteStore({ path: "holtkeeper.db" })',
)

const secretSchema = z.custom<Secret>(
  (value) => typeof value === 'string' || (isObject(value) && typeof value.env === 'string'),
  'expected a string or env("NAME")',
)

/** Where generated files (image variants, optimized SVGs) are kept, see `@holtkeeper/artifacts`. */
const artifactsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fs'), dir: z.string().min(1) }),
  z.object({
    kind: z.literal('s3'),
    bucket: z.string().min(1),
    /** AWS by default; set it for MinIO, Cloudflare R2, Garage and other S3-compatible services. */
    endpoint: z.url().optional(),
    region: z.string().optional(),
    accessKeyId: secretSchema,
    secretAccessKey: secretSchema,
    sessionToken: secretSchema.optional(),
    /** Key prefix inside the bucket. */
    prefix: z.string().optional(),
    virtualHostedStyle: z.boolean().optional(),
  }),
])

/** The web server: who may sign in, where data lives and how secrets are sealed. */
const serverSchema = z.object({
  auth: authSchema,
  store: storeSchema,
  /** Seals credentials and secret settings at rest; at least 32 characters. */
  vaultKey: secretSchema,
  hostname: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(7420),
  /** Directory with the built web UI. Default: the `apps/web/dist` next to the server. */
  webRoot: z.string().optional(),
  /** How often credentials due for rotation are checked. Default one hour; `0` disables it. */
  rotationIntervalMinutes: z.number().int().nonnegative().default(60),
  /** Shorthand for `artifacts: { kind: 'fs', dir }`. Default `.holtkeeper/artifacts`. */
  artifactsDir: z.string().min(1).optional(),
  /** Artifact storage; wins over `artifactsDir`. */
  artifacts: artifactsSchema.optional(),
  /**
   * Artifacts not accessed for `days` are removed, then the least recently used ones beyond
   * `maxBytes`; checked hourly. Default: kept forever.
   */
  retention: z
    .object({
      days: z.number().positive().optional(),
      maxBytes: z.number().int().positive().optional(),
    })
    .optional(),
  /** The SQLite file behind `store`, so the storage overview can report its size. */
  databasePath: z.string().min(1).optional(),
  /**
   * Where forges reach the server, e.g. `https://holtkeeper.example.com`; webhook URLs are built
   * from it. Default: the origin of the request that asks for the URL.
   */
  publicUrl: z.url().optional(),
})

const cronNicknames = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly'])

/**
 * Shape check only: five or six fields (seconds first when six) or a nickname such as `@daily`.
 * `@holtkeeper/jobs` parses every expression with croner before scheduling and rejects the rest.
 */
export const looksLikeCron = (expression: string) => {
  const trimmed = expression.trim()
  if (cronNicknames.has(trimmed.toLowerCase())) return true
  const fields = trimmed.split(/\s+/)
  return (
    (fields.length === 5 || fields.length === 6) &&
    fields.every((field) => /^[\d*?,/#LW-]+$|^[A-Za-z]{3}([-,][A-Za-z]{3})*$/.test(field))
  )
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM, e.g. "09:30"')

/** Days of the week as smart schedules name them. */
export const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

const scheduleWindowSchema = z.object({
  days: z.array(z.enum(weekdays)).min(1),
  /** Local time the window opens; a window whose `to` is not after `from` runs past midnight. */
  from: hhmm,
  to: hhmm,
})

/** Whether `zone` is an IANA time zone this runtime knows. */
export const isTimeZone = (zone: string) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== ''
  } catch {
    return false
  }
}

/** `15m`, `1h`, `6h`, `1d`, ...: minutes, hours or days. */
export const everyPattern = /^([1-9]\d*)(m|h|d)$/

/**
 * When a schedule may run, evaluated in its time zone. A run that falls into a denied minute moves
 * to the next allowed one.
 */
const scheduleWindowsSchema = z.object({
  /** When set, runs happen only inside one of these windows. */
  allow: z.array(scheduleWindowSchema).optional(),
  deny: z.array(scheduleWindowSchema).optional(),
  skipWeekends: z.boolean().optional(),
  /** A nightly pause, e.g. `{ from: '22:00', to: '07:00' }`. */
  skipNights: z.object({ from: hhmm, to: hhmm }).optional(),
  /** Whole local days without runs, `YYYY-MM-DD`. */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')).optional(),
})

const scheduleSchema = z
  .object({
    name: id,
    /** Human-readable name for the UI. */
    title: z.string().min(1).optional(),
    /** Disabled schedules stay in the config but never run. Default `true`. */
    enabled: z.boolean().default(true),
    /** Croner syntax. Exactly one of `cron` and `every` is required. */
    cron: z
      .string()
      .refine(looksLikeCron, 'expected a cron expression, e.g. "0 3 * * 1"')
      .optional(),
    /** Fixed interval aligned to the start of each allowed window (or local midnight). */
    every: z.string().regex(everyPattern, 'expected an interval such as 15m, 1h or 1d').optional(),
    /** IANA zone the schedule is evaluated in. Default: the server's zone. */
    timezone: z.string().refine(isTimeZone, 'expected an IANA time zone').optional(),
    windows: scheduleWindowsSchema.optional(),
    /** Delays each run by a stable pseudo-random 0..n minutes. */
    jitterMinutes: z.number().int().nonnegative().max(1440).optional(),
    /** Spreads repository jobs over the run window instead of queueing them all at once. */
    spread: z.boolean().optional(),
    /** Analyzer kinds to run. */
    analyzers: z.array(z.string().min(1)).min(1),
    /** Config groups whose repositories are analyzed; every group when omitted. */
    groups: z.array(z.string()).optional(),
    /** Only repositories matching one of these `forge:path` globs, e.g. `work:games/*`. */
    repos: z.array(z.string().regex(/^[^:]+:.+$/, 'expected forge:path')).optional(),
    /** Options per analyzer kind. */
    options: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .refine((schedule) => (schedule.cron === undefined) !== (schedule.every === undefined), {
    message: 'set exactly one of cron and every',
  })

/** One schedule of `jobs.schedules`, with defaults applied. */
export type ScheduleConfig = z.output<typeof scheduleSchema>

/**
 * Where job commands run: `host` (as the server process), `mise` (on the host with the repository's
 * tool versions) or `container` (one sandboxed container per job, see `@holtkeeper/exec-container`).
 * The scoped `toolchain` setting can override `image` and `network` per repository.
 */
const executionSchema = z.object({
  mode: z.enum(['host', 'mise', 'container']).default('host'),
  /** Container image; default `holtkeeper-worker:latest`, built from `docker/worker`. */
  image: z.string().min(1).optional(),
  /** Default: docker when installed, else podman. */
  engine: z.enum(['docker', 'podman']).optional(),
  limits: z
    .object({
      cpus: z.number().positive().optional(),
      memory: z
        .string()
        .regex(/^\d+[kmg]?$/i, 'expected e.g. 4g')
        .optional(),
      pids: z.number().int().positive().optional(),
    })
    .optional(),
  /** `none`: never; `install`: only while mise installs tools; `full`: always. Default `install`. */
  network: z.enum(['none', 'install', 'full']).optional(),
  /** `uid:gid` inside the container; default the image's `holtkeeper` user (10001). */
  user: z
    .string()
    .regex(/^\d+(:\d+)?$/, 'expected uid or uid:gid')
    .optional(),
})

/** Background analyses: schedules, forge webhooks and the worker that runs them. */
const jobsSchema = z.object({
  execution: executionSchema.optional(),
  /** Jobs run at the same time; one repository never runs two jobs at once. */
  concurrency: z.number().int().positive().default(2),
  /** Bare mirrors of analyzed repositories, reused between jobs. */
  cacheDir: z.string().default('.holtkeeper/cache'),
  timeoutMinutes: z.number().positive().default(30),
  schedules: z.array(scheduleSchema).default([]),
  /** Analyzers run for a repository when a tag is pushed (forge webhook). */
  onTag: z
    .object({
      analyzers: z.array(z.string().min(1)).min(1),
      /** Only repositories of these groups; every repository when omitted. */
      groups: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Analyzers run when a merge request is opened, gets new commits or is reopened (forge webhook).
   * Jobs get `{ mergeRequest: <iid> }` as options and the head commit as `ref`.
   */
  onMergeRequest: z
    .object({
      analyzers: z.array(z.string().min(1)).min(1),
      /** Default: all three. `update` means new commits or leaving draft. */
      actions: z.array(z.enum(['open', 'update', 'reopen'])).optional(),
      /** Also run for draft merge requests. Default `false`. */
      draft: z.boolean().default(false),
      /** Only repositories of these groups; every repository when omitted. */
      groups: z.array(z.string()).optional(),
    })
    .optional(),
  /** Analyzers run when a label is added to a merge request, by label. */
  onLabel: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).optional(),
  /**
   * Merge request comment commands: `/holtkeeper <name> [args]` queues `analyzer` with
   * `{ mergeRequest: <iid> }`, positional `args` mapped to the option names listed here (the last
   * one takes the rest as a list) and `key=value` arguments as options.
   */
  commands: z
    .record(
      z.string().regex(/^[a-z][\w-]*$/, 'expected a lowercase command name'),
      z.object({ analyzer: z.string().min(1), args: z.array(z.string().min(1)).optional() }),
    )
    .optional(),
  /** Username Holtkeeper posts as; its own webhook events are ignored. */
  botUsername: z.string().min(1).optional(),
  /** Shared secret forge webhooks must send; webhooks are refused without it. */
  webhookSecret: secretSchema.optional(),
  /** Per-forge webhook secrets for `POST /api/webhooks/<forge>`, by forge id. */
  webhooks: z.record(id, z.object({ secret: secretSchema })).optional(),
})

/** Credential limits shared by forge clients, agents and job admission (`@holtkeeper/limits`). */
const limitsSchema = z.object({
  /**
   * Keep limiter counters in the store (`kv`) instead of in process memory, so several server and
   * worker processes share each credential's limits. Needs a store whose `kv` implements
   * `compareAndSet` (SQLite, Postgres). Default `false`.
   */
  distributed: z.boolean().default(false),
})

const groupSchema = z.object({
  forge: z.string(),
  include: z.array(z.string()).min(1),
  exclude: z.array(z.string()).default([]),
})

const repoSchema = z.object({
  forge: z.string().optional(),
  traits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
})

/** Validates a whole config, including references between sections and every plugin's options. */
export const configSchema = z
  .object({
    dryRun: z.boolean().default(false),
    forges: z.record(id, forgeSchema),
    groups: z.record(id, groupSchema).default({}),
    repos: z.record(z.string(), repoSchema).default({}),
    plugins: z.array(pluginUseSchema).default([]),
    server: serverSchema.optional(),
    jobs: jobsSchema.optional(),
    limits: limitsSchema.optional(),
  })
  .superRefine((config, ctx) => {
    for (const [name, group] of Object.entries(config.groups)) {
      if (!(group.forge in config.forges)) {
        ctx.addIssue({
          code: 'custom',
          path: ['groups', name, 'forge'],
          message: `unknown forge "${group.forge}"`,
        })
      }
    }

    for (const [pattern, repo] of Object.entries(config.repos)) {
      if (repo.forge && !(repo.forge in config.forges)) {
        ctx.addIssue({
          code: 'custom',
          path: ['repos', pattern, 'forge'],
          message: `unknown forge "${repo.forge}"`,
        })
      }
    }

    const unknownGroups = (groups: string[] | undefined, path: PropertyKey[]) => {
      for (const group of groups ?? []) {
        if (!(group in config.groups)) {
          ctx.addIssue({ code: 'custom', path, message: `unknown group "${group}"` })
        }
      }
    }
    const scheduleNames = new Set<string>()
    for (const [index, schedule] of (config.jobs?.schedules ?? []).entries()) {
      const path = ['jobs', 'schedules', index]
      if (scheduleNames.has(schedule.name)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `schedule "${schedule.name}" is defined twice`,
        })
      }
      scheduleNames.add(schedule.name)
      unknownGroups(schedule.groups, [...path, 'groups'])
      for (const pattern of schedule.repos ?? []) {
        const forge = pattern.slice(0, pattern.indexOf(':'))
        if (!(forge in config.forges)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'repos'],
            message: `unknown forge "${forge}"`,
          })
        }
      }
    }
    for (const forge of Object.keys(config.jobs?.webhooks ?? {})) {
      if (!(forge in config.forges)) {
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', 'webhooks', forge],
          message: `unknown forge "${forge}"`,
        })
      }
    }
    unknownGroups(config.jobs?.onTag?.groups, ['jobs', 'onTag', 'groups'])
    unknownGroups(config.jobs?.onMergeRequest?.groups, ['jobs', 'onMergeRequest', 'groups'])

    const names = new Set<string>()
    for (const [index, use] of config.plugins.entries()) {
      const path = ['plugins', index]
      const { name, options } = use.plugin

      if (names.has(name)) {
        ctx.addIssue({ code: 'custom', path, message: `plugin "${name}" is used twice` })
      }
      names.add(name)

      for (const group of use.groups) {
        if (!(group in config.groups)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'groups'],
            message: `unknown group "${group}"`,
          })
        }
      }

      const base = use.options ?? {}
      const variants: [PropertyKey[], object][] = [
        [['options'], base],
        ...Object.entries(use.overrides ?? {}).map(
          ([pattern, override]): [PropertyKey[], object] => [
            ['overrides', pattern],
            { ...base, ...override },
          ],
        ),
      ]
      for (const [suffix, value] of variants) {
        const result = options.safeParse(value)
        for (const issue of result.error?.issues ?? []) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, ...suffix, ...issue.path],
            message: issue.message,
          })
        }
      }
    }
  })

export type HoltkeeperConfigInput = z.input<typeof configSchema>
export type HoltkeeperConfig = z.output<typeof configSchema>

/** Identity helper that types a config module's default export. */
export const defineConfig = (config: HoltkeeperConfigInput): HoltkeeperConfigInput => config

/** Thrown for missing or invalid configs; the message lists every problem by path. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** Validates a config object and applies defaults. */
export function parseConfig(input: unknown): HoltkeeperConfig {
  const result = configSchema.safeParse(input)
  if (!result.success) throw new ConfigError(z.prettifyError(result.error))
  return result.data
}

/** Imports a config module and validates its default export. */
export async function loadConfig(file: string): Promise<HoltkeeperConfig> {
  const path = resolve(file)
  if (!(await Bun.file(path).exists())) throw new ConfigError(`config not found: ${path}`)
  const module: unknown = await import(pathToFileURL(path).href)
  if (!isObject(module) || module.default === undefined) {
    throw new ConfigError(`${path} has no default export`)
  }
  return parseConfig(module.default)
}

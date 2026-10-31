import { parseArgs } from 'node:util'

import { claudeAgent } from '@holtkeeper/agent'
import { builtinAnalyzers } from '@holtkeeper/analyzers'
import { ConfigError, loadConfig, resolveRepo } from '@holtkeeper/core'

import {
  analyzeUsage,
  analyzerArgOptions,
  formatReportText,
  runAnalyzer,
  uploadAnalysis,
} from './analyze.ts'
import {
  type AuditServices,
  UsageError,
  auditCommand,
  defaultAuditServices,
  formatReport,
  parseTraits,
  uploadReport,
} from './audit.ts'
import { type StartServer, serve, serveOptions } from './serve.ts'
import { usersCommand } from './users.ts'

const usage = `Usage: holtkeeper <command> [options]

Commands:
  validate-config           Check the config file
  explain <forge>:<path>    Show groups, traits and plugin options for a repository
  audit [dir]               Scan a checkout for vulnerable dependencies (default: .)
  analyze <kind> [dir]      Run an analysis (see "Analyze options") and print its report
  serve                     Start the web server from the config's \`server\` section
  users <action>            Manage accounts of \`users\` sign-in in the config's store:
                            list, add <name>, login-link <user>, enroll-link <user>,
                            recover-link <user> (user is an id, email or name)

Options:
  -c, --config <file>       Config file (default: holtkeeper.config.ts)
  -h, --help                Show this help

Serve options:
  --role <roles>            web, worker, scheduler or all (default; also HOLTKEEPER_ROLE);
                            combine with commas, e.g. web,scheduler
  --concurrency <n>         Jobs this worker runs at once (default: jobs.concurrency)
  --max-jobs <n>            Exit 0 after running n jobs (one job per container or pod)
  --drain-timeout <time>    On SIGTERM, let running jobs finish this long, e.g. 30s (default)

Users options:
  --admin                   users add: every action on everything (default: no grants)
  --email <address>         users add: the account's email
  --ttl <time>              Link lifetime, e.g. 15m or 2h (login 15m, others 72h)
  --json                    Print JSON

A login link signs its holder in once, without a passkey: hand it to an AI agent that drives
the web UI. Treat it like a password until it expires.

Audit options:
  --fix                     Try to fix findings and rescan
  --allowlist <file>        JSON array of allowlist entries
  --trait <key=value>       Repository trait for conditional allowlist entries (repeatable)
  --json                    Print the full report as JSON
  --upload <url>            Send the report to a Holtkeeper server, e.g. http://localhost:7420
  --repo <forge>:<path>     Repository the report belongs to (required with --upload)

audit exits with 1 while unfixed, non-allowlisted findings remain.

Analyze options (--json prints the data, --upload/--repo send it to a server):
  --ref <name>              Release or tag the result belongs to
  --model <id>              LLM for analyzers that use one (needs ANTHROPIC_API_KEY)
${analyzeUsage(builtinAnalyzers)}`

/** Where the CLI writes; tests capture it. */
export interface Io {
  out(line: string): void
  err(line: string): void
}

export interface CliServices {
  audit?: () => AuditServices
  fetch?: typeof fetch
  /** Replaces `startServer` from `@holtkeeper/server` (tests). */
  startServer?: StartServer
  /** Resolves when `serve` should stop; default SIGINT or SIGTERM. */
  untilStopped?: () => Promise<void>
}

const untilSignal = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })

/** Runs the CLI and resolves with the process exit code. */
export async function cli(argv: string[], io: Io, services: CliServices = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c', default: 'holtkeeper.config.ts' },
      help: { type: 'boolean', short: 'h', default: false },
      fix: { type: 'boolean', default: false },
      allowlist: { type: 'string' },
      trait: { type: 'string', multiple: true, default: [] },
      json: { type: 'boolean', default: false },
      upload: { type: 'string' },
      repo: { type: 'string' },
      ref: { type: 'string' },
      model: { type: 'string' },
      role: { type: 'string' },
      concurrency: { type: 'string' },
      'max-jobs': { type: 'string' },
      'drain-timeout': { type: 'string' },
      admin: { type: 'boolean', default: false },
      email: { type: 'string' },
      ttl: { type: 'string' },
      ...analyzerArgOptions(builtinAnalyzers),
    },
  })
  const [command, ...args] = positionals

  if (values.help || !command) {
    io.out(usage)
    return values.help ? 0 : 1
  }

  try {
    switch (command) {
      case 'validate-config': {
        const config = await loadConfig(values.config)
        io.out(
          `config is valid: ${Object.keys(config.forges).length} forge(s), ` +
            `${Object.keys(config.groups).length} group(s), ${config.plugins.length} plugin(s)`,
        )
        return 0
      }
      case 'explain': {
        const target = args[0]
        const separator = target?.indexOf(':') ?? -1
        if (!target || separator < 1) {
          throw new UsageError(
            'explain expects a repository as <forge>:<path>, e.g. work:games/app-x',
          )
        }
        const config = await loadConfig(values.config)
        const forge = target.slice(0, separator)
        const resolved = resolveRepo(config, { forge, path: target.slice(separator + 1) })
        io.out(
          JSON.stringify(
            {
              ...resolved,
              plugins: resolved.plugins.map(({ plugin, options }) => ({
                name: plugin.name,
                options,
              })),
            },
            null,
            2,
          ),
        )
        return 0
      }
      case 'audit': {
        if (values.upload && !values.repo)
          throw new UsageError('--upload needs --repo <forge>:<path>')
        const startedAt = new Date().toISOString()
        const report = await auditCommand(
          {
            dir: args[0] ?? '.',
            fix: values.fix,
            allowlist: values.allowlist,
            traits: parseTraits(values.trait),
          },
          (services.audit ?? defaultAuditServices)(),
        )
        io.out(values.json ? JSON.stringify(report, null, 2) : formatReport(report))
        if (values.upload && values.repo) {
          const url = await uploadReport(
            values.upload,
            values.repo,
            report,
            startedAt,
            services.fetch ?? fetch,
          )
          io.err(`uploaded: ${url}`)
        }
        return report.findings.length ? 1 : 0
      }
      case 'analyze': {
        const [kind, dir = '.'] = args
        const analyzer = builtinAnalyzers.find((candidate) => candidate.kind === kind)
        if (!analyzer) {
          throw new UsageError(
            `analyze expects one of: ${builtinAnalyzers.map((a) => a.kind).join(', ')}`,
          )
        }
        if (values.upload && !values.repo)
          throw new UsageError('--upload needs --repo <forge>:<path>')
        const apiKey = Bun.env.ANTHROPIC_API_KEY
        const agent =
          analyzer.needs.agent && apiKey
            ? claudeAgent({
                apiKey,
                ...(typeof values.model === 'string' ? { model: values.model } : {}),
              })
            : undefined
        const { data, ref, artifacts } = await runAnalyzer({
          analyzer,
          dir,
          values,
          ...(agent ? { agent } : {}),
          ...(typeof values.ref === 'string' ? { ref: values.ref } : {}),
        })
        if (values.json) io.out(JSON.stringify(data, null, 2))
        else {
          const record = {
            id: 'local',
            repo: { forge: 'local', path: dir },
            kind: analyzer.kind,
            ...(ref ? { ref } : {}),
            createdAt: new Date().toISOString(),
            data,
          }
          io.out(formatReportText(analyzer.analysis.toReport(record)))
        }
        if (values.upload && values.repo) {
          const url = await uploadAnalysis(
            values.upload,
            values.repo,
            {
              kind: analyzer.kind,
              ...(ref ? { ref } : {}),
              data,
              ...(artifacts?.length ? { artifacts } : {}),
            },
            services.fetch ?? fetch,
          )
          io.err(`uploaded: ${url}`)
        }
        return 0
      }
      case 'serve': {
        const options = await serveOptions(values)
        const config = await loadConfig(values.config)
        const start = services.startServer ?? (await import('@holtkeeper/server')).startServer
        return await serve(
          config,
          { ...options, log: (line) => io.out(line) },
          start,
          services.untilStopped ?? untilSignal,
          (line) => io.out(line),
        )
      }
      case 'users':
        return await usersCommand(await loadConfig(values.config), args, values, (line) =>
          io.out(line),
        )
      default:
        throw new UsageError(`unknown command "${command}"\n\n${usage}`)
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UsageError) {
      io.err(error.message)
      return 1
    }
    throw error
  }
}

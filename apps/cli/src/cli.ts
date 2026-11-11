import { parseArgs } from 'node:util'

import { ConfigError, loadConfig } from '@holtkeeper/core'

import { type StartServer, UsageError, serve, serveOptions } from './serve.ts'
import { usersCommand } from './users.ts'

const usage = `Usage: holtkeeper <command> [options]

Commands:
  serve                     Start the server from the config's \`server\` section
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
  --claim-delay <time>      Take only jobs queued this long, e.g. 15s, so workers without one
                            get new jobs first (also HOLTKEEPER_CLAIM_DELAY)
  --pool <pools>            Worker pools this worker serves, e.g. write (default: default; also
                            HOLTKEEPER_WORKER_POOL); combine with commas, e.g. default,write
  --max-jobs <n>            Exit 0 after running n jobs (one job per container or pod)
  --drain-timeout <time>    On SIGTERM, let running jobs finish this long, e.g. 30s (default)

Users options:
  --admin                   users add: every action on everything (default: no grants)
  --email <address>         users add: the account's email
  --ttl <time>              Link lifetime, e.g. 15m or 2h (login 15m, others 72h)
  --json                    Print JSON

A login link signs its holder in once, without a passkey: hand it to an AI agent that drives
the web UI. Treat it like a password until it expires.`

/** Where the CLI writes; tests capture it. */
export interface Io {
  out(line: string): void
  err(line: string): void
}

export interface CliServices {
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
      json: { type: 'boolean', default: false },
      role: { type: 'string' },
      concurrency: { type: 'string' },
      'claim-delay': { type: 'string' },
      pool: { type: 'string' },
      'max-jobs': { type: 'string' },
      'drain-timeout': { type: 'string' },
      admin: { type: 'boolean', default: false },
      email: { type: 'string' },
      ttl: { type: 'string' },
    },
  })
  const [command, ...args] = positionals

  if (values.help || !command) {
    io.out(usage)
    return values.help ? 0 : 1
  }

  try {
    switch (command) {
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

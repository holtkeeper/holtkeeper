#!/usr/bin/env bun
import { cli } from './cli.ts'

const code = await cli(Bun.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
// Timers of libraries (pollers, keep-alive sockets) must not keep a stopped `serve` alive.
process.exit(code)

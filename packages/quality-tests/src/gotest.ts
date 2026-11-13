/** Why the tests of a Go package produced no coverage. */
export type GoNotRunReason = 'build failed' | 'setup failed' | 'timed out'

/** What `go test -json` reported per package. */
export interface GoTestOutcome {
  /** Packages whose test binary ran, passing, failing or replayed from the cache. */
  ran: string[]
  /** Packages whose tests ran and failed. */
  failed: string[]
  /** Packages without test files. */
  noTests: string[]
  /** Packages whose tests produced no coverage, with the reason and Go's first error line. */
  notRun: { pkg: string; reason: GoNotRunReason; error?: string }[]
  /** Compiler and loader output of failed builds, in the order Go printed it. */
  buildOutput: string
}

interface GoTestEvent {
  Action?: string
  Package?: string
  Test?: string
  Output?: string
  ImportPath?: string
  FailedBuild?: string
}

function parseEvent(line: string): GoTestEvent | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const event: unknown = JSON.parse(line)
    return event && typeof event === 'object' ? event : undefined
  } catch {
    return undefined
  }
}

const firstError = (output: string | undefined) =>
  output
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'))

/**
 * Reads the events `go test -json` writes to stdout. Package results come from package-level
 * `pass`, `fail` and `skip` events; a failed package counts as not run when Go marks it as a failed
 * build (`FailedBuild`, or a `[build failed]`/`[setup failed]` frame from older Go) or when its
 * binary hit `-timeout`. Lines that are not JSON events are ignored.
 */
export function parseGoTestEvents(stdout: string): GoTestOutcome {
  const outcome: GoTestOutcome = { ran: [], failed: [], noTests: [], notRun: [], buildOutput: '' }
  const output = new Map<string, string>()
  const builds = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const event = parseEvent(line.trim())
    if (!event?.Action) continue
    if (event.Action === 'build-output' && event.ImportPath) {
      builds.set(event.ImportPath, (builds.get(event.ImportPath) ?? '') + (event.Output ?? ''))
      outcome.buildOutput += event.Output ?? ''
      continue
    }
    const pkg = event.Package
    if (!pkg) continue
    if (event.Action === 'output') {
      output.set(pkg, (output.get(pkg) ?? '') + (event.Output ?? ''))
      continue
    }
    if (event.Test) continue
    const text = output.get(pkg) ?? ''
    if (event.Action === 'skip') {
      outcome.noTests.push(pkg)
      continue
    }
    if (event.Action === 'pass') {
      if (
        /^\?\s|^\s+\S+\s+(\[no test files\]|coverage:)/m.test(text) &&
        !/^(ok|PASS)\b/m.test(text)
      )
        outcome.noTests.push(pkg)
      else outcome.ran.push(pkg)
      continue
    }
    if (event.Action !== 'fail') continue
    const framed = /\[(build failed|setup failed)\]/.exec(text)?.[1]
    const frame: GoNotRunReason | undefined =
      framed === 'build failed' || framed === 'setup failed' ? framed : undefined
    if (event.FailedBuild !== undefined || frame) {
      const error = firstError(event.FailedBuild ? builds.get(event.FailedBuild) : undefined)
      outcome.notRun.push({
        pkg,
        reason: frame ?? 'build failed',
        ...(error ? { error } : {}),
      })
    } else if (/panic: test timed out after/.test(text)) {
      outcome.notRun.push({ pkg, reason: 'timed out' })
    } else {
      outcome.ran.push(pkg)
      outcome.failed.push(pkg)
    }
  }
  return outcome
}

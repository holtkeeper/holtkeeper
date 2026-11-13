import { join } from 'node:path'

import { type GraphLayer, type GraphSource, PartialLoadError } from '@holtkeeper/depgraph'
import { localRunner, runChecked } from '@holtkeeper/exec'
import type { CommandRunner } from '@holtkeeper/exec'

import { findGoModules, parseGoWork, readGoModules } from './gomod.ts'
import { goWorkspaceGraph, parseGoModGraph } from './graph.ts'

/** Options of `goSource`. */
export interface GoSourceOptions {
  /** Runs `go`; defaults to local child processes. */
  runner?: CommandRunner
  /** How deep to look for `go.mod` files when there is no `go.work` (default 4). */
  depth?: number
  timeoutMs?: number
}

/**
 * Environment of every `go` command: never download a toolchain, and let `go` resolve the module
 * graph even when `go.sum` or a `vendor/` directory is out of date.
 */
export const goEnv: Readonly<Record<string, string>> = { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod' }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Go modules: a `workspaces` layer from `go.work` (or every `go.mod` in the tree when there is
 * none) and a `packages` layer from `go mod graph`: one for the whole `go.work`, or one per module
 * otherwise, since separate modules are separate builds. The `workspaces` layer needs no `go`
 * command, so when `go mod graph` fails `load` throws `PartialLoadError` with that layer and the
 * `packages` layers that did load. `go mod graph` may download module metadata and, with
 * `-mod=mod`, update `go.mod`/`go.sum`, so run it on a disposable checkout.
 */
export function goSource(options: GoSourceOptions = {}): GraphSource {
  const { runner = localRunner, depth = 4, timeoutMs } = options
  const graph = async (cwd: string, env: Record<string, string>) =>
    (
      await runChecked(runner, ['go', 'mod', 'graph'], {
        cwd,
        env: { ...goEnv, ...env },
        timeoutMs,
      })
    ).stdout

  return {
    name: 'go',
    async detect(dir) {
      if (await Bun.file(join(dir, 'go.work')).exists()) return true
      return (await findGoModules(dir, depth)).length > 0
    },
    async load(dir) {
      const work = Bun.file(join(dir, 'go.work'))
      if (await work.exists()) {
        const modules = await readGoModules(dir, parseGoWork(await work.text()))
        const workspaces: GraphLayer = {
          id: 'workspaces',
          source: 'go.work',
          graph: goWorkspaceGraph(modules),
        }
        let output: string
        try {
          output = await graph(dir, { GOWORK: join(dir, 'go.work') })
        } catch (error) {
          throw new PartialLoadError([workspaces], [messageOf(error)])
        }
        return [
          workspaces,
          { id: 'packages', source: 'go mod graph', graph: parseGoModGraph(output, modules) },
        ]
      }
      const modules = await readGoModules(dir, await findGoModules(dir, depth))
      const results = await Promise.all(
        modules.map(async (module) => {
          const source = modules.length === 1 ? 'go mod graph' : `go mod graph (${module.dir})`
          try {
            const output = await graph(join(dir, module.dir), { GOWORK: 'off' })
            const layer: GraphLayer = {
              id: 'packages',
              source,
              graph: parseGoModGraph(output, modules),
            }
            return { layer }
          } catch (error) {
            return {
              error: modules.length === 1 ? messageOf(error) : `${module.dir}: ${messageOf(error)}`,
            }
          }
        }),
      )
      const layers: GraphLayer[] = [
        { id: 'workspaces', source: 'go.mod', graph: goWorkspaceGraph(modules) },
        ...results.flatMap((result) => (result.layer ? [result.layer] : [])),
      ]
      const errors = results.flatMap((result) => (result.error ? [result.error] : []))
      if (errors.length) throw new PartialLoadError(layers, errors)
      return layers
    },
  }
}

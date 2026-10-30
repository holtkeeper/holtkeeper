import type { RuntimeConfigView } from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/api'
import { Download, FileCode } from 'lucide-react'

import { api } from '../../api/endpoints.ts'
import { useRuntimeConfig } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import { formatGroupMatch } from '../../lib/scope.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  Notice,
  Panel,
  Placeholder,
  Table,
  Td,
  Th,
  buttonClass,
} from '../../ui/index.ts'
import { ChipList, Fact } from './shared.tsx'

/** The parts of the config only the file sets, read-only, and a download of the whole config. */
export function RuntimeTab() {
  const runtime = useRuntimeConfig()
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Config file"
        description="Job execution, storage, limits, AI provider packages and plugins are set in holtkeeper.config.ts and cannot be changed here."
        actions={
          <a
            href={api.configExportUrl()}
            download="holtkeeper.config.ts"
            className={buttonClass('secondary', 'sm')}
          >
            <Download className="size-4" />
            Export config
          </a>
        }
      >
        <p className="text-sm text-muted">
          The export holds the effective forges, groups, repository traits and jobs, panel changes
          included, with secrets as <code className="font-mono text-xs">env()</code> placeholders.
          Use it to move panel changes into the file.
        </p>
      </Panel>
      {runtime.isPending ? (
        <Placeholder className="h-64" />
      ) : runtime.isError ? (
        <ErrorState error={runtime.error} />
      ) : (
        <RuntimeView view={runtime.data} />
      )}
    </div>
  )
}

function RuntimeView({ view }: { view: RuntimeConfigView }) {
  const { jobs, server } = view
  const execution = jobs?.execution
  return (
    <>
      {view.dryRun ? (
        <Notice tone="warning" title="Dry run">
          Holtkeeper evaluates everything but changes nothing on the forges.
        </Notice>
      ) : null}
      <Panel title="Jobs" description="Where and how analyzers run.">
        {jobs ? (
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Fact label="Execution">
              <span className="flex flex-wrap items-center gap-1">
                <Chip tone="accent">{execution?.mode ?? 'host'}</Chip>
                {execution?.engine ? <Chip>{execution.engine}</Chip> : null}
              </span>
            </Fact>
            {execution?.image ? (
              <Fact label="Image">
                <span className="font-mono text-xs">{execution.image}</span>
              </Fact>
            ) : null}
            {execution?.network ? <Fact label="Network">{execution.network}</Fact> : null}
            {execution?.limits ? (
              <Fact label="Container limits">
                {[
                  execution.limits.cpus !== undefined ? `${execution.limits.cpus} CPU` : undefined,
                  execution.limits.memory,
                  execution.limits.pids !== undefined ? `${execution.limits.pids} pids` : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </Fact>
            ) : null}
            {execution?.egress ? (
              <Fact label="Egress proxy">
                <span className="flex flex-wrap items-center gap-1">
                  <span className="font-mono text-xs">{execution.egress.proxy}</span>
                  {execution.egress.ca ? <Chip>own CA</Chip> : null}
                </span>
              </Fact>
            ) : null}
            {execution?.user ? (
              <Fact label="User">
                <span className="font-mono text-xs">{execution.user}</span>
              </Fact>
            ) : null}
            <Fact label="Concurrency">{plural(jobs.concurrency, 'job')} at once</Fact>
            <Fact label="Timeout">{jobs.timeoutMinutes} min</Fact>
            <Fact label="Cache">
              <span className="font-mono text-xs">{jobs.cacheDir}</span>
            </Fact>
            <Fact label="Bot user">
              {jobs.botUsername ? (
                <span className="font-mono text-xs">{jobs.botUsername}</span>
              ) : (
                <span className="text-muted">Not set</span>
              )}
            </Fact>
            <Fact label="Schedules">{jobs.schedules}</Fact>
          </dl>
        ) : (
          <EmptyState
            icon={<FileCode />}
            title="No jobs section"
            description="Schedules and triggers need the job engine, which starts only when the config file has a jobs section."
          />
        )}
      </Panel>
      <Panel title="Server" description="Public address, artifact storage and retention.">
        {server ? (
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Fact label="Public URL">
              {server.publicUrl ? (
                <span className="font-mono text-xs">{server.publicUrl}</span>
              ) : (
                <span className="text-muted">From each request</span>
              )}
            </Fact>
            <Fact label="Rotation check">every {server.rotationIntervalMinutes} min</Fact>
            <Fact label="Artifacts">
              {server.artifacts.kind === 'fs' ? (
                <span className="font-mono text-xs">{server.artifacts.dir}</span>
              ) : (
                <span className="font-mono text-xs">
                  s3://{server.artifacts.bucket}
                  {server.artifacts.prefix ? `/${server.artifacts.prefix}` : ''}
                  {server.artifacts.endpoint ? ` · ${server.artifacts.endpoint}` : ''}
                  {server.artifacts.region ? ` · ${server.artifacts.region}` : ''}
                </span>
              )}
            </Fact>
            <Fact label="Retention">
              {server.retention?.days !== undefined || server.retention?.maxBytes !== undefined
                ? [
                    server.retention.days !== undefined
                      ? plural(server.retention.days, 'day')
                      : undefined,
                    server.retention.maxBytes !== undefined
                      ? formatBytes(server.retention.maxBytes)
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Keep everything'}
            </Fact>
          </dl>
        ) : (
          <p className="text-sm text-muted">No server section; defaults apply.</p>
        )}
      </Panel>
      <Panel title="Limits and AI">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Rate limits">
            {view.limits.distributed ? 'Shared across processes' : 'Per process'}
          </Fact>
          <Fact label="AI provider packages">
            <ChipList values={view.aiProviders} fallback="Shipped providers only" />
          </Fact>
        </dl>
      </Panel>
      <Panel title="Plugins" description="Automations and the groups they apply to.">
        {view.plugins.length ? (
          <Table label="Plugins">
            <thead>
              <tr>
                <Th>Plugin</Th>
                <Th>Groups</Th>
                <Th>Excluded</Th>
                <Th>Overrides</Th>
              </tr>
            </thead>
            <tbody>
              {view.plugins.map((plugin, index) => (
                <tr key={`${plugin.name}-${index}`}>
                  <Td>
                    <span className="font-mono text-[13px]">{plugin.name}</span>
                  </Td>
                  <Td>
                    <ChipList values={plugin.groups.map(formatGroupMatch)} fallback="All groups" />
                  </Td>
                  <Td>
                    <ChipList values={plugin.exclude} />
                  </Td>
                  <Td>
                    <ChipList values={plugin.overrides} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-muted">No plugins configured.</p>
        )}
      </Panel>
    </>
  )
}

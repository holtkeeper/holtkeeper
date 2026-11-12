import { Link } from '@tanstack/react-router'
import { Compass, Lightbulb, Search } from 'lucide-react'
import { Fragment, use } from 'react'

import { useRepos } from '../../api/queries.ts'
import { parseRepoKey, repoKey, repoSplat, suggestRepos } from '../../lib/repo.ts'
import { Button, Kbd, LinkButton } from '../../ui/index.ts'
import { openPalette } from './palette.ts'
import { SessionContext } from './session.ts'

function NotFoundCard({ repo }: { repo: string | undefined }) {
  const signedIn = use(SessionContext) !== null
  const repos = useRepos(signedIn && repo !== undefined)
  const suggestions = repo
    ? suggestRepos(
        repo,
        (repos.data?.repos ?? []).map((r) => r.repo),
      )
    : []
  const ref = repo ? parseRepoKey(repo) : undefined
  return (
    <div className="grid flex-1 place-items-center px-4 py-10">
      <section
        aria-labelledby="not-found-title"
        className="w-full max-w-[520px] rounded-[10px] border border-line bg-panel"
      >
        <div className="flex gap-3 p-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-raise text-muted">
            <Compass className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 id="not-found-title" className="text-[14px] font-semibold">
              Page not found
            </h2>
            <p className="mt-1 text-sm text-muted">
              {repo ? (
                <>
                  No repository <span className="mono text-foreground">{ref?.path ?? repo}</span>{' '}
                  that you can see
                  {ref ? (
                    <>
                      {' '}
                      on <span className="mono text-foreground">{ref.forge}</span>
                    </>
                  ) : null}
                  .
                </>
              ) : (
                'The address does not match any page.'
              )}
            </p>
          </div>
        </div>
        {suggestions.length ? (
          <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-sm">
            <Lightbulb className="size-4 shrink-0 text-accent" />
            <span>
              Did you mean{' '}
              {suggestions.map((suggestion, index) => (
                <Fragment key={repoKey(suggestion)}>
                  {index ? (index === suggestions.length - 1 ? ' or ' : ', ') : null}
                  <Link
                    to="/repos/$"
                    params={{ _splat: repoSplat(suggestion) }}
                    className="mono text-accent hover:underline"
                  >
                    {suggestion.path}
                  </Link>
                </Fragment>
              ))}
              ?
            </span>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
          <LinkButton to="/" variant="primary" size="sm">
            Go to Home
          </LinkButton>
          {signedIn ? (
            <Button variant="secondary" size="sm" onPress={openPalette}>
              <Search className="size-3.5" />
              Search
              <Kbd>⌘K</Kbd>
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  )
}

/** An address that matches no page, shown inside the shell so the rail stays usable. */
export function NotFound() {
  return <NotFoundCard repo={undefined} />
}

/** A repository key (`forge:path`) the viewer cannot see, with close ones they can. */
export function RepoNotFound({ repo }: { repo: string }) {
  return <NotFoundCard repo={repo} />
}

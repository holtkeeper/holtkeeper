import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { libraryKey, parseLibraryKey, parseLibraryTab } from '../../lib/dependencies.ts'
import { EmptyState, Page } from '../../ui/index.ts'
import { LibraryDetail } from './LibraryDetail.tsx'

/** One library on its own page, `/dependencies/<ecosystem>/<name>`, with the sheet's tabs. */
export function LibraryPage() {
  const { ecosystem, _splat: name } = useParams({ strict: false })
  const search: { tab?: string } = useSearch({ strict: false })
  const navigate = useNavigate()
  const library = parseLibraryKey(`${ecosystem ?? ''}:${name ?? ''}`)
  const tab = parseLibraryTab(search.tab)
  const back = (
    <Link
      to="/dependencies"
      search={library ? { library: libraryKey(library) } : {}}
      className="inline-flex items-center gap-1 hover:underline"
    >
      <ArrowLeft className="size-3.5" />
      Dependencies
    </Link>
  )
  if (!library)
    return (
      <Page title="Unknown library" eyebrow={back} icon="updates">
        <EmptyState title="No such library" description="Ecosystems are npm and Go." />
      </Page>
    )
  return (
    <Page title={<span className="mono">{library.name}</span>} eyebrow={back} icon="updates">
      <LibraryDetail
        library={library}
        tab={tab}
        onTab={(next) =>
          void navigate({
            to: '/dependencies/$ecosystem/$',
            params: { ecosystem: library.ecosystem, _splat: library.name },
            search: next !== 'overview' ? { tab: next } : {},
            replace: true,
          })
        }
      />
    </Page>
  )
}

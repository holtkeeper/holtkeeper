import { useAccount } from '../../api/queries.ts'
import { actionLabels, roleLabel, summarizeGrants } from '../../lib/access.ts'
import { formatDate } from '../../lib/format.ts'
import { describeScope } from '../../lib/scope.ts'
import { Avatar, EmptyState, KeyValue, Panel, Table, Tag, Td, Th } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

/** "Given by": the person who invited the viewer and when; nothing when no person did. */
function GivenBy() {
  const account = useAccount()
  const creator = account.data?.creator
  if (!account.data || !creator) return null
  return (
    <KeyValue
      rows={[
        {
          label: 'Given by',
          value: (
            <>
              <Avatar src={creator.avatarUrl} name={creator.name} size="xs" />
              <span>{creator.name}</span>
              <span className="text-muted">on {formatDate(account.data.createdAt)}</span>
            </>
          ),
        },
      ]}
    />
  )
}

/** Account › My access: the viewer's role and each grant with where it applies and what it allows. */
export function MyAccess() {
  const { principal, auth } = useSession()
  const { grants } = principal
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {roleLabel(grants)}
          <span className="font-normal text-muted">{summarizeGrants(grants)}</span>
        </span>
      }
      description="Grants decide what you can open and change; the server checks every request."
    >
      {auth.provider === 'users' ? <GivenBy /> : null}
      {grants.length ? (
        <Table label="Your grants">
          <thead>
            <tr>
              <Th>Where</Th>
              <Th>Allows</Th>
            </tr>
          </thead>
          <tbody>
            {grants.map((grant, index) => (
              <tr key={index}>
                <Td className="mono text-xs whitespace-nowrap">{describeScope(grant.scope)}</Td>
                <Td>
                  {grant.actions.includes('*') ? (
                    'Everything'
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {grant.actions.map((action) =>
                        action === '*' ? null : (
                          <Tag key={action} title={action}>
                            {actionLabels[action]}
                          </Tag>
                        ),
                      )}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No grants" description="Ask an admin to give you access." />
      )}
    </Panel>
  )
}

import type { SecretReportingMode } from '@holtkeeper/api'

import { reportingModeOptions } from '../../lib/secret-reports.ts'
import { Segmented } from '../../ui/index.ts'
import { LicenseButton } from '../secret-reports/LicenseDialog.tsx'

const modeNotes: Record<SecretReportingMode, string> = {
  named:
    'Administrators see that the report came from you, so they can ask what happened if they need to.',
  anonymous:
    'The report keeps no name and only the day it arrived, and the call is left out of usage statistics. Holtkeeper cannot hide everything: proxies in front of it may log requests, and in a small team the context may give you away.',
  off: 'Your agents do not report exposed secrets. Rotate anything you leak yourself.',
}

/**
 * The "Report exposed secrets" choice of an MCP token with what reporting means, why it helps,
 * what protects the person and the limits of anonymity, plus a link to the license. Used by the
 * New token dialog and the per-token change dialog.
 */
export function SecretReportsChoice({
  value,
  onChange,
  isDisabled,
}: {
  value: SecretReportingMode
  onChange: (mode: SecretReportingMode) => void
  isDisabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-sm">Report exposed secrets</span>
        <Segmented
          aria-label="Report exposed secrets"
          value={value}
          onChange={onChange}
          options={reportingModeOptions}
          {...(isDisabled ? { isDisabled } : {})}
        />
      </div>
      <p className="text-xs text-foreground">{modeNotes[value]}</p>
      <div className="flex flex-col gap-2 rounded-[7px] border border-line bg-raise px-3 py-2.5 text-xs text-muted">
        <p>
          If a key, token or password of the organization shows up in a conversation with your
          agent, the agent sends administrators a short report: the variable name, the service, a
          mask like <code className="mono">wk_l…(40)</code> and a description without names. Never
          the value.
        </p>
        <p>
          Anything in the chat has already reached the model provider, so the secret counts as
          compromised even if nothing bad happened; the sooner it is rotated, the shorter the
          window. People rarely notice such slips, the agent notices at once. Leaks happen to
          everyone: the report exists to close the hole, not to find someone to blame.
        </p>
        <p>
          Nobody can require you to turn this on. Under the license, the organization may not use
          reports, or your choice, for sanctions, dismissal or performance reviews. Administrators
          do not see which option you picked.
        </p>
        <p>
          The license's use condition is mandatory for the organization running this Holtkeeper.{' '}
          <LicenseButton />
        </p>
      </div>
    </div>
  )
}

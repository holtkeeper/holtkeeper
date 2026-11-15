import { describe, expect, test } from 'bun:test'

import {
  type SecurityAlertContent,
  securityAlertMessage,
  securityAlertReply,
} from './security-alert.ts'

const content = (extra: Partial<SecurityAlertContent> = {}): SecurityAlertContent => ({
  advisory: {
    id: 'GHSA-aaaa-0001',
    url: 'https://osv.test/GHSA-aaaa-0001',
    aliases: ['GHSA-aaaa-0001', 'CVE-2026-1000'],
    summary: 'Template injection in <widget-render> @channel',
  },
  package: 'widget-render',
  ecosystem: 'npm',
  severity: 'critical',
  fixedIn: ['1.2.1'],
  category: 'code-execution',
  reason: 'Runs attacker code & reads secrets.',
  repos: [
    { label: 'g/app', url: 'https://git.test/g/app', versions: ['1.2.0'] },
    { label: 'g/shop', versions: ['1.1.0', '1.2.0'], fixing: true },
  ],
  moreUrl: 'https://holtkeeper.test/supply/security',
  ...extra,
})

const shown = (message: { blocks?: readonly Record<string, unknown>[] }) =>
  JSON.stringify(message.blocks ?? [])

describe('securityAlertMessage', () => {
  test('shows the advisory, why it is urgent and every repository', () => {
    const message = securityAlertMessage(content())
    expect(message.text).toBe(
      'Urgent vulnerability GHSA-aaaa-0001 in widget-render: 2 repositories',
    )
    const blocks = shown(message)
    expect(blocks).toContain('🚨 Urgent vulnerability: widget-render')
    expect(blocks).toContain('<https://osv.test/GHSA-aaaa-0001|GHSA-aaaa-0001>* · CVE-2026-1000')
    expect(blocks).toContain('&lt;widget-render&gt;')
    expect(blocks).toContain('Code execution')
    expect(blocks).toContain('Runs attacker code &amp; reads secrets.')
    expect(blocks).toContain('Affected repositories (2)')
    expect(blocks).toContain('• <https://git.test/g/app|g/app> — `1.2.0`')
    expect(blocks).toContain('• g/shop — `1.1.0`, `1.2.0` _(upgrade in progress)_')
    expect(blocks).toContain('<https://holtkeeper.test/supply/security|All findings>')
  })

  test('marks a resolved alert and keeps its content', () => {
    const message = securityAlertMessage(content({ resolvedAt: '2026-11-20T10:00:00.000Z' }))
    expect(message.text).toBe('Resolved: GHSA-aaaa-0001 in widget-render')
    const blocks = shown(message)
    expect(blocks).toContain('✅ Resolved: widget-render')
    expect(blocks).toContain('Was in 2 repositories')
    expect(blocks).toContain('No repository has it since 2026-11-20')
  })

  test('says when there is no fix and stays within Slack limits for long lists', () => {
    const repos = Array.from({ length: 400 }, (_, index) => ({
      label: `g/widget-service-with-a-long-name-${index}`,
      url: `https://git.test/g/widget-service-with-a-long-name-${index}`,
      versions: ['1.2.0'],
    }))
    const message = securityAlertMessage(content({ fixedIn: [], repos }))
    const blocks = shown(message)
    expect(blocks).toContain('no fix yet')
    expect(blocks).toContain('more in <https://holtkeeper.test/supply/security|Holtkeeper>')
    for (const block of message.blocks ?? []) {
      const text = (block as { text?: { text?: string } }).text?.text ?? ''
      expect(text.length).toBeLessThanOrEqual(3000)
    }
  })
})

describe('securityAlertReply', () => {
  test('names the repositories that joined or came back', () => {
    const repos = [{ label: 'g/shop', url: 'https://git.test/g/shop', versions: ['1.2.0'] }]
    expect(securityAlertReply('added', repos).text).toBe(
      '*Also found in*\n• <https://git.test/g/shop|g/shop> — `1.2.0`',
    )
    expect(securityAlertReply('reopened', repos).text).toStartWith('*Found again in*')
  })
})

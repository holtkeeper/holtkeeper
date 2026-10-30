import { expect, test } from 'bun:test'

import { inlineSyntaxOf, optimizeInlineSvgs, optimizePathData } from './inline.ts'

const heavy =
  'M12.000000 2.000000C6.4771525 2.000000 2.000000 6.4771525 2.000000 12.000000C2.000000 17.5228475 6.4771525 22.000000 12.000000 22.000000C17.5228475 22.000000 22.000000 17.5228475 22.000000 12.000000C22.000000 6.4771525 17.5228475 2.000000 12.000000 2.000000Z'

test('shortens path data and keeps dots of round caps', () => {
  const d = optimizePathData(heavy)
  expect(d.length).toBeLessThan(heavy.length / 2)
  expect(d).not.toContain('.000000')
  expect(optimizePathData('M12 12h.01')).toBe('M12 12h.01')
  expect(optimizePathData('')).toBe('')
})

test('rewrites a static SVG in HTML whole and keeps ids and classes', () => {
  const html = `<header>\n  <!-- logo -->\n  <svg class="logo" viewBox="0 0 24 24"><!-- drawn in Figma --><metadata>x</metadata><path id="ring" d="${heavy}"/></svg>\n</header>\n`
  const [finding, ...rest] = optimizeInlineSvgs(html, { syntax: 'html' })
  expect(rest).toEqual([])
  expect(finding).toMatchObject({ kind: 'svg', line: 3, endLine: 3, paths: 1 })
  expect(finding?.newText).toContain('class="logo"')
  expect(finding?.newText).toContain('id="ring"')
  expect(finding?.newText).toContain('viewBox="0 0 24 24"')
  expect(finding?.newText).not.toContain('metadata')
  expect(html.slice(finding?.start, finding?.end)).toBe(finding?.oldText ?? '')
  expect(finding?.digits.after).toBeLessThan(finding?.digits.before ?? 0)
})

test('only touches d values in JSX and in SVGs with bindings', () => {
  const tsx = [
    'export const Ring = (props: Props) => (',
    `  <svg {...props} viewBox="0 0 24 24" strokeWidth={2}>`,
    `    <path d="${heavy}" />`,
    `    <path d={'${heavy}'} fill={props.color} />`,
    '  </svg>',
    ')',
    `export const Dot = () => <path d="${heavy}" />`,
  ].join('\n')
  const findings = optimizeInlineSvgs(tsx, { syntax: 'jsx' })
  expect(
    findings.map((finding) => [finding.kind, finding.line, finding.endLine, finding.paths]),
  ).toEqual([
    ['paths', 2, 5, 2],
    ['paths', 7, 7, 1],
  ])
  const block = findings[0]?.newText ?? ''
  expect(block).toContain('{...props}')
  expect(block).toContain('strokeWidth={2}')
  expect(block).toContain("d={'M")
  expect(block).not.toContain(heavy)

  const vue = `<template><svg :class="cls" viewBox="0 0 24 24"><path d="${heavy}"/></svg></template>`
  expect(optimizeInlineSvgs(vue, { syntax: 'vue' })[0]?.kind).toBe('paths')
})

test('skips fragments that are already small', () => {
  const tsx = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/></svg>'
  expect(optimizeInlineSvgs(tsx, { syntax: 'jsx' })).toEqual([])
  expect(optimizeInlineSvgs(tsx, { syntax: 'html' })).toEqual([])
})

test('knows the markup flavour of a file', () => {
  expect(['a.tsx', 'b.vue', 'c.svelte', 'd.html', 'e.ts'].map(inlineSyntaxOf)).toEqual([
    'jsx',
    'vue',
    'svelte',
    'html',
    undefined,
  ])
})

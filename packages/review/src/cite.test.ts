import { expect, test } from 'bun:test'

import { citedRules } from './citations.ts'
import { type CitedRuleInfo, citationRenderer, plainCitations, renderCitations } from './cite.ts'

const known = new Map<string, CitedRuleInfo>([
  [
    'rule:r1',
    {
      title: 'Widgets [core]',
      text: 'Keep widgets "pure".\nNo I/O in render.',
      url: 'https://panel.example.com/knowledge/rules?rule=r1',
    },
  ],
  ['learn:l1', { title: 'Round at the boundary', text: 'Round at the boundary.' }],
])

const text = 'Render reads a file [rule:r1]. Round later [learn:l1], see also [rule:gone].'

test('link keeps the citation as a link titled with the rule name', () => {
  const shown = renderCitations(text, 'link', known)
  expect(shown).toBe(
    'Render reads a file [\\[rule:r1\\]](https://panel.example.com/knowledge/rules?rule=r1 "Widgets [core]"). Round later [learn:l1], see also<!-- [rule:gone] -->.',
  )
  expect(citedRules(shown)).toEqual(citedRules(text))
  expect(renderCitations(shown, 'link', known)).toBe(shown)
  expect(plainCitations(shown)).toBe(
    'Render reads a file [rule:r1]. Round later [learn:l1], see also<!-- [rule:gone] -->.',
  )
})

test('details appends each cited rule once', () => {
  const shown = renderCitations(`${text} Again [rule:r1].`, 'details', known)
  expect(shown.match(/<details>/g)).toHaveLength(2)
  expect(shown).toContain(
    '<details><summary>rule:r1: Widgets [core]</summary>\n\nKeep widgets "pure".\nNo I/O in render.\n\n</details>',
  )
})

test('off shows nothing and still records what was cited', () => {
  const shown = renderCitations('Reads a file ([rule:r1]). Done [learn:l1]', 'off', known)
  expect(shown).toBe('Reads a file<!-- [rule:r1] -->. Done<!-- [learn:l1] -->')
  expect(citedRules(shown).map((cited) => cited.id)).toEqual(['r1', 'l1'])
})

test('the renderer looks up only what a note cites and survives a failing lookup', async () => {
  const asked: string[][] = []
  const render = citationRenderer('link', async (cited) => {
    asked.push(cited.map((item) => item.id))
    return known
  })
  expect(await render('Nothing cited.')).toBe('Nothing cited.')
  expect(await render('See [rule:r1].')).toContain('[\\[rule:r1\\]](https://panel.example.com')
  expect(asked).toEqual([['r1']])
  const failing = citationRenderer('link', async () => {
    throw new Error('store is down')
  })
  expect(await failing('See [rule:r1].')).toBe('See<!-- [rule:r1] -->.')
  expect(await citationRenderer('off')('See [rule:r1].')).toBe('See<!-- [rule:r1] -->.')
})

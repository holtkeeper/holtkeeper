import { expect, test } from 'bun:test'

import { compileTemplate, parseRepo, requiredCheckouts, templateVars } from './layers.ts'

const vars = templateVars('games/slots-x')

test('templateVars splits the repository path', () => {
  expect(vars).toEqual({ repo: 'games/slots-x', repoName: 'slots-x', group: 'games' })
  expect(templateVars('solo')).toEqual({ repo: 'solo', repoName: 'solo', group: '' })
})

test('templates capture locale and namespace and render paths back', () => {
  const template = compileTemplate('games/{repoName}/{locale}/{namespace}.json', vars)
  expect(template.match('games/slots-x/pt_BR/ui.json')).toEqual({
    locale: 'pt-BR',
    namespace: 'ui',
  })
  expect(template.match('games/poker/ru/ui.json')).toBeUndefined()
  expect(template.match('games/slots-x/notalocale/ui.json')).toBeUndefined()
  expect(template.render({ locale: 'de', namespace: 'ui' })).toBe('games/slots-x/de/ui.json')
  expect(template.hasNamespace).toBe(true)
})

test('templates accept globs and group placeholders', () => {
  const deep = compileTemplate('{group}/**/{locale}.yml', vars)
  expect(deep.match('games/a/b/ru.yml')).toEqual({ locale: 'ru' })
  expect(deep.match('games/ru.yml')).toEqual({ locale: 'ru' })
  expect(deep.render({ locale: 'ru' })).toBeUndefined()
  const star = compileTemplate('src/*/{locale}.json', vars)
  expect(star.match('src/app/en.json')).toEqual({ locale: 'en' })
  expect(star.match('src/a/b/en.json')).toBeUndefined()
  expect(compileTemplate('{repo}/{locale}.po', vars).render({ locale: 'uk' })).toBe(
    'games/slots-x/uk.po',
  )
})

test('requiredCheckouts lists other repositories once', () => {
  const analyzed = parseRepo('work:games/slots-x')
  expect(
    requiredCheckouts(
      {
        layers: [
          { repo: 'work:i18n/translations', ref: 'main' },
          { repo: 'work:i18n/translations', ref: 'main' },
          { repo: 'work:games/slots-x' },
          {},
        ],
      },
      analyzed,
    ),
  ).toEqual([{ repo: { forge: 'work', path: 'i18n/translations' }, ref: 'main' }])
  expect(() => parseRepo('nocolon')).toThrow()
})

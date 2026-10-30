import { expect, test } from 'bun:test'

import type { EncodedVariant } from '@holtkeeper/media'

import { proposedVariants, usageOf } from './optimize.ts'
import { cssReferences, findReferences, imgReferences, resolveImage } from './usages.ts'

const assets = new Set(['public/hero.png', 'src/assets/logo.png', 'public/img/bg.jpg'])

test('URLs resolve against the file, served roots and the src alias', () => {
  expect(resolveImage('src/App.tsx', '/hero.png', assets)).toBe('public/hero.png')
  expect(resolveImage('src/App.tsx', './assets/logo.png', assets)).toBe('src/assets/logo.png')
  expect(resolveImage('src/pages/Home.vue', '@/assets/logo.png', assets)).toBe(
    'src/assets/logo.png',
  )
  expect(resolveImage('src/styles/main.css', '../../public/img/bg.jpg?v=2', assets)).toBe(
    'public/img/bg.jpg',
  )
  expect(resolveImage('index.html', 'hero.png', assets)).toBe('public/hero.png')
  expect(resolveImage('src/App.tsx', 'https://cdn.example.com/hero.png', assets)).toBeUndefined()
  expect(resolveImage('src/App.tsx', '/img/${name}.png', assets)).toBeUndefined()
})

test('img tags keep their other attributes; responsive, dynamic and picture tags are skipped', () => {
  const text = [
    'export const App = () => (',
    '  <main>',
    '    <img src="/hero.png" alt="Hero" className={styles.cover} width={640} data-test="hero" />',
    '    <img src={hero} alt="dynamic" />',
    '    <img src="/hero.png" srcSet="/hero-640w.png 640w" />',
    '    <picture><img src="/hero.png" /></picture>',
    "    <img src={'./assets/logo.png'} />",
    '  </main>',
    ')',
  ].join('\n')
  const found = imgReferences('src/App.tsx', text, assets)
  expect(found).toHaveLength(2)
  expect(found[0]).toMatchObject({
    asset: 'public/hero.png',
    kind: 'img',
    framework: 'react',
    src: '/hero.png',
    alt: 'Hero',
    width: 640,
    indent: '    ',
    line: 3,
    attributes: 'className={styles.cover} data-test="hero"',
  })
  expect(text.slice(found[0]?.start, found[0]?.end)).toBe(found[0]?.text ?? '')
  expect(found[1]).toMatchObject({ asset: 'src/assets/logo.png', src: './assets/logo.png' })
})

test('CSS background declarations without image-set', () => {
  const text =
    '.hero {\n  color: red;\n  background-image: url("/hero.png");\n}\n.logo { background: #fff url(../assets/logo.png) no-repeat }\n.done { background-image: url(/hero.png); background-image: image-set(url(/hero.avif) type("image/avif")); }'
  const found = cssReferences('src/styles/app.css', text, assets)
  expect(found.map((reference) => [reference.asset, reference.property, reference.line])).toEqual([
    ['public/hero.png', 'background-image', 3],
    ['src/assets/logo.png', 'background', 5],
  ])
  expect(found[0]?.text).toBe('background-image: url("/hero.png");')
  expect(found[1]?.value).toBe('#fff url(../assets/logo.png) no-repeat')
  const grouped = findReferences(new Map([['src/styles/app.css', text]]), assets)
  expect([...grouped.keys()]).toEqual(['public/hero.png', 'src/assets/logo.png'])
})

const img = (width?: number) => ({
  file: 'a.html',
  asset: 'x.png',
  kind: 'img' as const,
  framework: 'html' as const,
  start: 0,
  end: 1,
  text: '',
  src: 'x.png',
  indent: '',
  line: 1,
  ...(width ? { width } : {}),
})
const variant = (format: EncodedVariant['format'], width: number, bytes: number) =>
  ({ format, width, bytes }) as EncodedVariant

test('usage decides the size ladder', () => {
  expect(usageOf([img(120), img(120)], [])).toEqual({ usage: 'fixed', displayWidth: 120 })
  expect(usageOf([img(120), img()], [])).toEqual({ usage: 'responsive' })
  expect(usageOf([], ['phaser'])).toEqual({ usage: 'texture' })
  expect(usageOf([], [])).toEqual({ usage: 'responsive' })
})

test('a format is proposed only when its full-size variant saves enough', () => {
  const list = [
    variant('avif', 320, 100),
    variant('avif', 640, 400),
    variant('png', 640, 990),
    variant('webp', 640, 700),
  ]
  const kept = proposedVariants(1000, list, 200)
  expect(list.map((entry) => kept.has(entry))).toEqual([true, true, false, true])
})

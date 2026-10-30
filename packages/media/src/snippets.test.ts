import { expect, test } from 'bun:test'

import {
  type SnippetVariant,
  formatOfFile,
  pictureSnippets,
  snippetFrameworks,
  variantFile,
} from './snippets.ts'

const responsive: SnippetVariant[] = [
  { format: 'avif', width: 640 },
  { format: 'avif', width: 1280 },
  { format: 'webp', width: 640 },
  { format: 'webp', width: 1280 },
  { format: 'jpeg', width: 640 },
  { format: 'jpeg', width: 1280, replacesOriginal: true },
]

const textures: SnippetVariant[] = [
  { format: 'webp', width: 256, density: 1 },
  { format: 'webp', width: 512, density: 2 },
  { format: 'png', width: 256, density: 1 },
  { format: 'png', width: 512, density: 2 },
]

const base = {
  file: '/images/hero.jpg',
  variants: responsive,
  alt: 'A "hero"',
  width: 1280,
  height: 720,
}

test('variant file names follow the naming scheme and keep the original extension', () => {
  expect(variantFile('/images/hero.jpg', { format: 'avif', width: 640 })).toBe(
    '/images/hero-640w.avif',
  )
  expect(variantFile('/images/hero.jpg', { format: 'jpeg', width: 640 })).toBe(
    '/images/hero-640w.jpg',
  )
  expect(
    variantFile('/images/hero.jpg', { format: 'jpeg', width: 1280, replacesOriginal: true }),
  ).toBe('/images/hero.jpg')
  expect(variantFile('ship.png', { format: 'webp', width: 512, density: 2 })).toBe('ship@2x.webp')
  expect(
    variantFile('a/ship.png', { format: 'webp', width: 512 }, { width: 'w{width}/{name}.{ext}' }),
  ).toBe('a/w512/ship.webp')
  expect(formatOfFile('x/y.JPG')).toBe('jpeg')
  expect(formatOfFile('x/y.bmp')).toBeUndefined()
})

test('HTML picture lists AVIF and WebP sources and a lazy img fallback', () => {
  const snippet = pictureSnippets({ ...base, framework: 'html', indent: '    ' })
  expect(snippet.language).toBe('html')
  expect(snippet.code).toBe(
    [
      '<picture>',
      '      <source type="image/avif" srcset="/images/hero-640w.avif 640w, /images/hero-1280w.avif 1280w" sizes="100vw">',
      '      <source type="image/webp" srcset="/images/hero-640w.webp 640w, /images/hero-1280w.webp 1280w" sizes="100vw">',
      '      <img src="/images/hero.jpg" srcset="/images/hero-640w.jpg 640w, /images/hero.jpg 1280w" sizes="100vw" width="1280" height="720" alt="A &quot;hero&quot;" loading="lazy" decoding="async">',
      '    </picture>',
    ].join('\n'),
  )
})

test('React uses camelCase attributes and numeric expressions; Vue self-closes', () => {
  const react = pictureSnippets({
    ...base,
    framework: 'react',
    attributes: 'className="cover"',
    sizes: '50vw',
  })
  expect(react.language).toBe('tsx')
  expect(react.code).toContain(
    'srcSet="/images/hero-640w.avif 640w, /images/hero-1280w.avif 1280w" sizes="50vw" />',
  )
  expect(react.code).toContain('width={1280} height={720}')
  expect(react.code).toContain('className="cover" loading="lazy" decoding="async" />')
  expect(react.code).not.toContain('srcset=')
  const vue = pictureSnippets({ ...base, framework: 'vue' })
  expect(vue.code).toContain('<source type="image/webp" srcset=')
  expect(vue.code).toContain('decoding="async" />')
  expect(vue.code.split('\n').at(-1)).toBe('</picture>')
})

test('density variants use x descriptors without sizes', () => {
  const html = pictureSnippets({ file: 'ship.png', variants: textures, framework: 'html' })
  expect(html.code).toContain('srcset="ship@1x.webp 1x, ship@2x.webp 2x">')
  expect(html.code).toContain(
    '<img src="ship@2x.png" srcset="ship@1x.png 1x, ship@2x.png 2x" alt=""',
  )
  expect(html.code).not.toContain('sizes=')
})

test('CSS image-set keeps a plain url() fallback', () => {
  const css = pictureSnippets({ ...base, framework: 'css' })
  expect(css.code).toBe(
    [
      'background-image: url("/images/hero.jpg");',
      'background-image: image-set(url("/images/hero-1280w.avif") type("image/avif"), url("/images/hero-1280w.webp") type("image/webp"), url("/images/hero.jpg") type("image/jpeg"));',
    ].join('\n'),
  )
  const densities = pictureSnippets({ file: 'ship.png', variants: textures, framework: 'css' })
  expect(densities.code).toContain(
    'url("ship@1x.webp") type("image/webp") 1x, url("ship@2x.webp") type("image/webp") 2x',
  )
})

test('framework notes for Next.js, Nuxt and Vite', () => {
  const next = pictureSnippets({ ...base, framework: 'next' })
  expect(next.code).toContain(`import Image from 'next/image'`)
  expect(next.code).toContain(
    '<Image src="/images/hero.jpg" alt="A &quot;hero&quot;" width={1280} height={720} sizes="100vw" />',
  )
  expect(next.notes[0]).toContain("formats: ['image/avif', 'image/webp']")
  const nuxt = pictureSnippets({ ...base, framework: 'nuxt' })
  expect(nuxt.code).toContain('<NuxtPicture src="/images/hero.jpg" format="avif,webp"')
  const vite = pictureSnippets({ ...base, framework: 'vite' })
  expect(vite.code).toContain(
    `import heroAvif from '/images/hero.jpg?w=640;1280&format=avif&as=srcset'`,
  )
  expect(vite.code).toContain('<source type="image/webp" srcSet={heroWebp} sizes="100vw" />')
  expect(vite.notes[0]).toContain('vite-imagetools')
})

test('game engines pick a format with a fallback and resolution variants', () => {
  const pixi = pictureSnippets({ file: 'textures/ship.png', variants: textures, framework: 'pixi' })
  expect(pixi.code).toContain(`Assets.load('textures/ship@{1,2}x.{webp,png}')`)
  expect(pixi.notes.some((note) => note.includes('KTX2'))).toBe(true)
  const phaser = pictureSnippets({
    file: 'textures/ship.png',
    variants: textures,
    framework: 'phaser',
  })
  expect(phaser.code).toContain(
    'const density = [1,2].find((value) => value >= window.devicePixelRatio) ?? 2',
  )
  expect(phaser.code).toContain(
    'const url = this.sys.game.device.features.webp ? `textures/ship@${density}x.webp` : `textures/ship@${density}x.png`',
  )
  expect(phaser.code).toContain(`this.load.image('ship', url)`)
  const three = pictureSnippets({
    file: 'textures/ship.png',
    variants: [{ format: 'avif', width: 256, density: 1 }, ...textures],
    framework: 'three',
  })
  expect(three.code).toContain(`(await decodes('image/avif', '`)
  expect(three.code).toContain('? `textures/ship@${density}x.avif`')
  expect(three.code).toContain('new TextureLoader().loadAsync(url)')
  const flat = pictureSnippets({ ...base, framework: 'pixi' })
  expect(flat.code).toContain(
    `Assets.load({ alias: 'hero', src: ['/images/hero-1280w.avif', '/images/hero-1280w.webp', '/images/hero.jpg'] })`,
  )
})

test('every framework produces code', () => {
  for (const framework of snippetFrameworks) {
    expect(pictureSnippets({ ...base, framework }).code.length).toBeGreaterThan(20)
  }
})

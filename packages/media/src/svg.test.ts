import { expect, test } from 'bun:test'

import { optimizeSvg, pathStats, scanTags } from './svg.ts'

const illustrator = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.5.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 24 24" style="enable-background:new 0 0 24 24;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#FF6600;}
	.st1{fill:none;stroke:#333333;stroke-width:1.5;stroke-miterlimit:10;}
</style>
<g>
	<path class="st0" d="M12.000000,2.250000c-5.384776,0-9.750000,4.365224-9.750000,9.750000s4.365224,9.750000,9.750000,9.750000
		s9.750000-4.365224,9.750000-9.750000S17.384776,2.250000,12.000000,2.250000z"/>
	<path id="check" class="st1" d="M7.500000,12.375000l3.000000,3.000000l6.000000-6.750000"/>
</g>
</svg>
`

const figma = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_1203_4471)">
<path d="M16.0001 29.3334C23.3639 29.3334 29.3334 23.3639 29.3334 16.0001C29.3334 8.63628 23.3639 2.66675 16.0001 2.66675C8.63628 2.66675 2.66675 8.63628 2.66675 16.0001C2.66675 23.3639 8.63628 29.3334 16.0001 29.3334Z" stroke="#1E1E1E" stroke-width="2.66667" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M16 10.6667V16.0001" stroke="#1E1E1E" stroke-width="2.66667" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M16 21.3333H16.0133" stroke="#1E1E1E" stroke-width="2.66667" stroke-linecap="round" stroke-linejoin="round"/>
</g>
<defs>
<clipPath id="clip0_1203_4471">
<rect width="32" height="32" fill="white"/>
</clipPath>
</defs>
</svg>
`

const inkscape = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   width="48" height="48" viewBox="0 0 48 48" id="svg8" inkscape:version="1.3 (0e150ed6c4, 2023-07-21)" sodipodi:docname="star.svg">
  <metadata id="metadata5"><rdf:RDF><dc:format>image/svg+xml</dc:format></rdf:RDF></metadata>
  <sodipodi:namedview id="base" pagecolor="#ffffff" inkscape:zoom="11.2" inkscape:cx="24" inkscape:cy="24" />
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <path style="fill:#ffcc00;fill-opacity:1;stroke:none;stroke-width:0.264583" id="star"
       d="m 24.000000,4.000000 5.877853,11.909830 13.143278,1.909830 -9.510565,9.270510 2.245139,13.090170 L 24.000000,34.000000 12.244295,40.180340 14.489434,27.090170 4.978869,17.819660 18.122147,15.909830 Z"
       inkscape:connector-curvature="0" sodipodi:nodetypes="ccccccccccc" />
    <rect style="fill:#000000;display:none" id="hidden" width="10" height="10" x="0" y="0" />
  </g>
</svg>
`

test('Illustrator export: prolog, comments, editor attributes and decimals go away', () => {
  const result = optimizeSvg(illustrator, { preset: 'default' })
  expect(result.bytes.after).toBeLessThan(result.bytes.before * 0.6)
  expect(result.gzip.after).toBeLessThan(result.gzip.before)
  expect(result.text).toContain('viewBox="0 0 24 24"')
  expect(result.text).not.toContain('<?xml')
  expect(result.text).not.toContain('Generator')
  const { breakdown } = result
  expect(breakdown.comments).toBe(1)
  expect(breakdown.metadata).toBe(2)
  expect(breakdown.removedAttributes).toMatchObject({ version: 1, 'xmlns:xlink': 1, x: 1, y: 1 })
  expect(breakdown.paths.before.digits).toBeGreaterThan(breakdown.paths.after.digits * 2)
  expect(breakdown.paths.after.coordinates).toBeLessThanOrEqual(breakdown.paths.before.coordinates)
  expect(breakdown.paths.before.longest[0]?.length).toBeGreaterThan(100)
  expect(breakdown.styles.elementsBefore).toBe(1)
  expect(breakdown.issues).toEqual([])
})

test('Figma export: paths merge, attributes move to the group and IDs are minified', () => {
  const result = optimizeSvg(figma)
  expect(result.preset).toBe('default')
  expect(result.breakdown.removedElements).toEqual({ path: 1, rect: 1 })
  expect(result.breakdown.removedAttributes).toMatchObject({ stroke: 2, 'stroke-width': 2 })
  expect(result.breakdown.paths.before.paths).toBe(3)
  expect(result.breakdown.paths.after.digits).toBeLessThan(
    result.breakdown.paths.before.digits / 1.5,
  )
  expect(result.breakdown.ids).toEqual({ before: 1, after: 1, minified: 1 })
  expect(result.text).toContain('clip-path="url(#a)"')
  expect(result.text).toContain('viewBox="0 0 32 32"')
})

test('Inkscape export: metadata, namedview and editor namespaces are counted', () => {
  const result = optimizeSvg(inkscape, { preset: 'default' })
  expect(result.text).not.toMatch(/inkscape|sodipodi|metadata|rdf:/)
  expect(result.breakdown.removedElements).toMatchObject({ metadata: 1, 'sodipodi:namedview': 1 })
  expect(result.breakdown.metadata).toBeGreaterThanOrEqual(3)
  expect(result.breakdown.removedAttributes['inkscape:connector-curvature']).toBe(1)
  expect(result.breakdown.styles.inlineBefore).toBe(2)
  expect(result.breakdown.styles.inlineAfter).toBe(0)
  expect(result.text).not.toContain('id="hidden"')
})

test('safe preset keeps IDs, styles, hidden elements and shapes', () => {
  const result = optimizeSvg(inkscape, { preset: 'safe' })
  for (const id of ['svg8', 'layer1', 'star', 'hidden']) expect(result.text).toContain(`id="${id}"`)
  expect(result.text).toContain('<rect')
  expect(result.text).toContain('style=')
  expect(result.text).not.toMatch(/sodipodi:namedview|<metadata/)
  expect(result.breakdown.ids.minified).toBe(0)
  expect(result.breakdown.ids.after).toBeGreaterThanOrEqual(4)
  expect(result.bytes.after).toBeLessThan(result.bytes.before)

  const illustratorSafe = optimizeSvg(illustrator, { preset: 'safe' })
  expect(illustratorSafe.text).toContain('id="check"')
  expect(illustratorSafe.text).toContain('class="st0"')
  expect(illustratorSafe.text).toContain('<style')
  const figmaSafe = optimizeSvg(figma, { preset: 'safe' })
  expect(figmaSafe.text).toContain('id="clip0_1203_4471"')
})

test('default preset keeps requested IDs; aggressive lowers precision further', () => {
  const kept = optimizeSvg(figma, { keepIds: ['clip0_1203_4471'] })
  expect(kept.text).toContain('clip0_1203_4471')
  const aggressive = optimizeSvg(illustrator, { preset: 'aggressive' })
  const normal = optimizeSvg(illustrator, { preset: 'default' })
  expect(aggressive.breakdown.paths.after.digits).toBeLessThanOrEqual(
    normal.breakdown.paths.after.digits,
  )
  expect(aggressive.text).toContain('viewBox')
})

test('size issues are reported', () => {
  const noBox = optimizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><path d="M0 0h10v20z"/></svg>',
  )
  expect(noBox.breakdown.issues.map((issue) => issue.code)).toEqual(['size-without-viewbox'])
  const mismatch = optimizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>',
  )
  expect(mismatch.breakdown.issues.map((issue) => issue.code)).toEqual(['aspect-mismatch'])
  const raster = optimizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>',
  )
  expect(raster.breakdown.issues.map((issue) => issue.code)).toEqual(['embedded-raster'])
  expect(() => optimizeSvg('<svg><path</svg>')).toThrow()
})

test('pathStats counts commands, coordinates and digits', () => {
  const stats = pathStats(
    scanTags('<svg><path id="a" d="M1.25 2L3 4.5z"/><path d="m0 0h1e2"/></svg>'),
  )
  expect(stats).toEqual({
    paths: 2,
    commands: 5,
    coordinates: 7,
    digits: 10,
    longest: [{ length: 14, id: 'a' }, { length: 8 }],
  })
})

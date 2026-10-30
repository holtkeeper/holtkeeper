const C1 = (0.01 * 255) ** 2
const C2 = (0.03 * 255) ** 2

/**
 * Mean SSIM of two 8-bit single-channel images of the same size over non-overlapping 8×8 windows
 * (edge windows are clipped). 1 means identical; ~0.98 and above is visually lossless for most
 * content. Cheap enough to run on downscaled luma inside a quality search.
 */
export function ssim(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  if (a.length < width * height || b.length < width * height)
    throw new Error('ssim: buffers are smaller than width × height')
  let total = 0
  let windows = 0
  for (let top = 0; top < height; top += 8) {
    for (let left = 0; left < width; left += 8) {
      const bottom = Math.min(height, top + 8)
      const right = Math.min(width, left + 8)
      let sumA = 0
      let sumB = 0
      let sumAA = 0
      let sumBB = 0
      let sumAB = 0
      const n = (bottom - top) * (right - left)
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const index = y * width + x
          const va = a[index] ?? 0
          const vb = b[index] ?? 0
          sumA += va
          sumB += vb
          sumAA += va * va
          sumBB += vb * vb
          sumAB += va * vb
        }
      }
      const meanA = sumA / n
      const meanB = sumB / n
      const varA = sumAA / n - meanA * meanA
      const varB = sumBB / n - meanB * meanB
      const cov = sumAB / n - meanA * meanB
      total +=
        ((2 * meanA * meanB + C1) * (2 * cov + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2))
      windows++
    }
  }
  return windows ? total / windows : 1
}

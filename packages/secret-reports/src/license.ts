/** Name of the license that covers secret reports. */
export const LICENSE_NAME = 'Holtkeeper Secret Reports License'

/**
 * The full text of the Holtkeeper Secret Reports License (the `LICENSE` file of this package),
 * with its use condition: reporting is voluntary and reports are never grounds for sanctions.
 */
export const licenseText = (): Promise<string> =>
  Bun.file(new URL('../LICENSE', import.meta.url)).text()

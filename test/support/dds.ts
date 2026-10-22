import { encodeDds } from "ac-dds"

/**
 * A texture Assetto Corsa reads correctly: DXT1, every mip level down to 1x1.
 * Copied out of the Buffer, whose `slice` is a view, so a test can edit one.
 */
export const dds = (width = 4, height = width): Uint8Array =>
  new Uint8Array(encodeDds(new Uint8Array(width * height * 4).fill(128), width, height))

/**
 * `dds(width, height)`'s header on `totalBytes` of zeros, for the size tests:
 * encoding an 8K texture for real would take longer than the rest of the suite.
 */
export const ddsOfSize = (totalBytes: number, width: number, height = width): Uint8Array => {
  const out = new Uint8Array(totalBytes)
  out.set(dds().subarray(0, 128))
  const view = new DataView(out.buffer)
  view.setUint32(12, height, true)
  view.setUint32(16, width, true)
  view.setUint32(28, Math.floor(Math.log2(Math.max(width, height))) + 1, true)
  return out
}

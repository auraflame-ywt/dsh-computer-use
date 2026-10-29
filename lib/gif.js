/**
 * Dependency-free animated GIF writer.
 *
 * Screen recordings become GIFs when no ffmpeg is available, so this module
 * owns the whole format: header, one global palette built from a uniform
 * 6x7x6 RGB lattice, a per-frame graphic control extension, and the LZW
 * payload each frame needs.
 */

const PALETTE_R = 6
const PALETTE_G = 7
const PALETTE_B = 6
const PALETTE_SIZE = PALETTE_R * PALETTE_G * PALETTE_B // 252, padded to 256

/** Quantize one 0..255 channel onto its lattice position. */
function levels(count) {
  const table = new Uint8Array(256)
  for (let value = 0; value < 256; value++) table[value] = Math.round((value * (count - 1)) / 255)
  return table
}

const R_LEVEL = levels(PALETTE_R)
const G_LEVEL = levels(PALETTE_G)
const B_LEVEL = levels(PALETTE_B)

/** Build the 256-entry global color table from the lattice. */
function buildPalette() {
  const table = Buffer.alloc(256 * 3)
  for (let index = 0; index < 256; index++) {
    const offset = index * 3
    if (index >= PALETTE_SIZE) continue
    const ri = Math.floor(index / (PALETTE_G * PALETTE_B))
    const rest = index % (PALETTE_G * PALETTE_B)
    const gi = Math.floor(rest / PALETTE_B)
    const bi = rest % PALETTE_B
    table[offset] = Math.round((ri * 255) / (PALETTE_R - 1))
    table[offset + 1] = Math.round((gi * 255) / (PALETTE_G - 1))
    table[offset + 2] = Math.round((bi * 255) / (PALETTE_B - 1))
  }
  return table
}

const PALETTE = buildPalette()

/** Map one RGB buffer onto palette indices. */
export function quantizeFrame(rgb) {
  const pixels = new Uint8Array(rgb.length / 3)
  for (let p = 0, q = 0; q < pixels.length; p += 3, q++) {
    pixels[q] =
      R_LEVEL[rgb[p]] * (PALETTE_G * PALETTE_B) + G_LEVEL[rgb[p + 1]] * PALETTE_B + B_LEVEL[rgb[p + 2]]
  }
  return pixels
}

/** Growable byte sink with the LSB-first bit packing GIF's LZW stream needs. */
class BitWriter {
  #chunks = []
  #buffer = 0
  #bits = 0
  #block = Buffer.alloc(255)
  #blockLength = 0

  #flushBlock() {
    if (this.#blockLength === 0) return
    const head = Buffer.from([this.#blockLength])
    this.#chunks.push(head, Buffer.from(this.#block.subarray(0, this.#blockLength)))
    this.#blockLength = 0
  }

  #pushByte(byte) {
    this.#block[this.#blockLength++] = byte
    if (this.#blockLength === 255) this.#flushBlock()
  }

  writeCode(code, codeSize) {
    this.#buffer |= code << this.#bits
    this.#bits += codeSize
    while (this.#bits >= 8) {
      this.#pushByte(this.#buffer & 0xff)
      this.#buffer >>= 8
      this.#bits -= 8
    }
  }

  finish() {
    if (this.#bits > 0) {
      this.#pushByte(this.#buffer & 0xff)
      this.#buffer = 0
      this.#bits = 0
    }
    this.#flushBlock()
    this.#chunks.push(Buffer.from([0])) // block terminator
    return Buffer.concat(this.#chunks)
  }
}

/** LZW-compress one palette-indexed frame into GIF sub-blocks. */
function lzwCompress(pixels, minCodeSize) {
  const writer = new BitWriter()
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1
  let codeSize = minCodeSize + 1
  let nextCode = endCode + 1
  let dictionary = new Map()

  writer.writeCode(clearCode, codeSize)
  if (pixels.length === 0) {
    writer.writeCode(endCode, codeSize)
    return writer.finish()
  }

  let prefix = pixels[0]
  for (let i = 1; i < pixels.length; i++) {
    const symbol = pixels[i]
    const key = (prefix << 8) | symbol
    const known = dictionary.get(key)
    if (known !== undefined) {
      prefix = known
      continue
    }
    writer.writeCode(prefix, codeSize)
    if (nextCode < 4096) {
      if (nextCode === 1 << codeSize) codeSize++
      dictionary.set(key, nextCode)
      nextCode++
    } else {
      writer.writeCode(clearCode, codeSize)
      dictionary = new Map()
      codeSize = minCodeSize + 1
      nextCode = endCode + 1
    }
    prefix = symbol
  }
  writer.writeCode(prefix, codeSize)
  writer.writeCode(endCode, codeSize)
  return writer.finish()
}

/**
 * Encode RGB frames into one animated GIF.
 * @param {{ width: number, height: number, frames: Uint8Array[], delayCs?: number, loop?: number }} input
 *   `frames` hold `width * height * 3` bytes of RGB24 each; `delayCs` is the
 *   per-frame delay in hundredths of a second.
 * @returns {Buffer} a complete GIF89a file.
 */
export function encodeAnimatedGif({ width, height, frames, delayCs = 10, loop = 0 }) {
  return encodeIndexedGif({
    width,
    height,
    delayCs,
    loop,
    indexFrames: frames.map((frame) => quantizeFrame(frame)),
  })
}

/**
 * Encode already-quantized frames into one animated GIF. Callers that process
 * frames one at a time use this so they never hold every RGB buffer at once.
 * @param {{ width: number, height: number, indexFrames: Uint8Array[], delayCs?: number, loop?: number }} input
 *   `indexFrames` hold one palette index per pixel.
 * @returns {Buffer} a complete GIF89a file.
 */
export function encodeIndexedGif({ width, height, indexFrames, delayCs = 10, loop = 0 }) {
  const frames = indexFrames
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid GIF dimensions ${width}x${height}`)
  }
  if (frames.length === 0) throw new Error('cannot encode a GIF without frames')
  const expected = width * height
  const parts = []

  parts.push(Buffer.from('GIF89a', 'ascii'))
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  screen[4] = 0xf7 // global color table, 8-bit color resolution, 256 entries
  screen[5] = 0 // background color index
  screen[6] = 0 // pixel aspect ratio
  parts.push(screen)
  parts.push(PALETTE)

  // NETSCAPE2.0 looping extension; 0 means forever.
  parts.push(Buffer.from([0x21, 0xff, 0x0b]))
  parts.push(Buffer.from('NETSCAPE2.0', 'ascii'))
  parts.push(Buffer.from([0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00]))

  for (const indices of frames) {
    if (indices.length !== expected) {
      throw new Error(`frame has ${indices.length} pixels, expected ${expected} for ${width}x${height}`)
    }
    const delay = Math.max(2, Math.round(delayCs))
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x04, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00]))
    const descriptor = Buffer.alloc(10)
    descriptor[0] = 0x2c
    descriptor.writeUInt16LE(0, 1)
    descriptor.writeUInt16LE(0, 3)
    descriptor.writeUInt16LE(width, 5)
    descriptor.writeUInt16LE(height, 7)
    descriptor[9] = 0x00 // no local color table, not interlaced
    parts.push(descriptor)
    parts.push(Buffer.from([0x08])) // minimum code size for an 8-bit palette
    parts.push(lzwCompress(indices, 8))
  }

  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

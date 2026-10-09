/**
 * Little-endian reader and writer for the Assetto Corsa client protocol.
 *
 * The game has two string encodings and uses both in the same packet: a u8
 * length followed by that many bytes, and a u8 length followed by that many
 * UTF-32LE code units. Which one a field uses is a property of the field, so
 * the caller says which rather than this guessing.
 */

export class WireReader {
  readonly #buf: Buffer
  #pos: number

  constructor(buf: Buffer, offset = 0) {
    this.#buf = buf
    this.#pos = offset
  }

  get offset(): number {
    return this.#pos
  }

  get remaining(): number {
    return this.#buf.length - this.#pos
  }

  #take(n: number): number {
    if (n < 0 || this.#pos + n > this.#buf.length) {
      throw new RangeError(`read of ${n} bytes at ${this.#pos} runs past ${this.#buf.length}`)
    }
    const at = this.#pos
    this.#pos += n
    return at
  }

  skip(n: number): void {
    this.#take(n)
  }

  u8(): number {
    return this.#buf.readUInt8(this.#take(1))
  }

  i8(): number {
    return this.#buf.readInt8(this.#take(1))
  }

  u16(): number {
    return this.#buf.readUInt16LE(this.#take(2))
  }

  i16(): number {
    return this.#buf.readInt16LE(this.#take(2))
  }

  u32(): number {
    return this.#buf.readUInt32LE(this.#take(4))
  }

  i32(): number {
    return this.#buf.readInt32LE(this.#take(4))
  }

  f32(): number {
    return this.#buf.readFloatLE(this.#take(4))
  }

  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()]
  }

  bytes(n: number): Buffer {
    const at = this.#take(n)
    return this.#buf.subarray(at, at + n)
  }

  /** u8 length, then that many bytes. */
  ascii(): string {
    return this.bytes(this.u8()).toString("utf8")
  }

  /** u8 length, then that many UTF-32LE code units. */
  utf32(): string {
    const n = this.u8()
    const raw = this.bytes(n * 4)
    let out = ""
    for (let i = 0; i < n; i++) out += String.fromCodePoint(raw.readUInt32LE(i * 4))
    return out
  }
}

export class WireWriter {
  #chunks: Buffer[] = []

  #push(size: number, write: (b: Buffer) => void): this {
    const b = Buffer.alloc(size)
    write(b)
    this.#chunks.push(b)
    return this
  }

  u8(v: number): this {
    return this.#push(1, (b) => b.writeUInt8(v))
  }

  i8(v: number): this {
    return this.#push(1, (b) => b.writeInt8(v))
  }

  u16(v: number): this {
    return this.#push(2, (b) => b.writeUInt16LE(v))
  }

  u32(v: number): this {
    return this.#push(4, (b) => b.writeUInt32LE(v))
  }

  f32(v: number): this {
    return this.#push(4, (b) => b.writeFloatLE(v))
  }

  vec3(v: readonly [number, number, number]): this {
    return this.f32(v[0]).f32(v[1]).f32(v[2])
  }

  bytes(v: Buffer): this {
    this.#chunks.push(v)
    return this
  }

  ascii(v: string): this {
    const b = Buffer.from(v, "utf8")
    if (b.length > 255) throw new RangeError(`string of ${b.length} bytes does not fit a u8 length`)
    return this.u8(b.length).bytes(b)
  }

  utf32(v: string): this {
    const points = [...v].map((c) => c.codePointAt(0)!)
    if (points.length > 255)
      throw new RangeError(`string of ${points.length} characters does not fit a u8 length`)
    this.u8(points.length)
    for (const p of points) this.u32(p)
    return this
  }

  build(): Buffer {
    return Buffer.concat(this.#chunks)
  }
}

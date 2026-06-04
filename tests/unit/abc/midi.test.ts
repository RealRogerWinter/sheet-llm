import { describe, it, expect } from 'vitest'
import { getMidiBytes } from '@/lib/abc/midi'

const C_MAJOR_SCALE = 'X:1\nT:Test\nM:4/4\nL:1/8\nK:C\nCDEF GABc|'

describe('getMidiBytes', () => {
  it('returns a Uint8Array starting with the MIDI MThd header', async () => {
    const bytes = await getMidiBytes(C_MAJOR_SCALE)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBeGreaterThan(0)
    // MIDI file format magic: 4D 54 68 64 ("MThd")
    expect(bytes[0]).toBe(0x4d)
    expect(bytes[1]).toBe(0x54)
    expect(bytes[2]).toBe(0x68)
    expect(bytes[3]).toBe(0x64)
  })

  it('produces different bytes for different scores', async () => {
    const a = await getMidiBytes(C_MAJOR_SCALE)
    const b = await getMidiBytes('X:1\nT:Two\nM:4/4\nL:1/8\nK:G\nGABc defg|')
    // Same magic header but different content
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })
})

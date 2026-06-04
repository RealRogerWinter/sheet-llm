import { describe, it, expect } from 'vitest'
import { generatePdf } from '@/lib/abc/pdf'

const C_MAJOR_SCALE = 'X:1\nT:C major\nM:4/4\nL:1/8\nK:C\nCDEF GABc|'

describe('generatePdf', () => {
  it('returns a Uint8Array starting with the PDF magic %PDF', async () => {
    const bytes = await generatePdf(C_MAJOR_SCALE, { title: 'C major' })
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBeGreaterThan(0)
    // %PDF = 0x25 0x50 0x44 0x46
    expect(bytes[0]).toBe(0x25)
    expect(bytes[1]).toBe(0x50)
    expect(bytes[2]).toBe(0x44)
    expect(bytes[3]).toBe(0x46)
  })

  it('cleans up the hidden render container', async () => {
    const before = document.body.children.length
    await generatePdf(C_MAJOR_SCALE)
    const after = document.body.children.length
    expect(after).toBe(before)
  })
})

import { describe, it, expect } from 'vitest'
import { detectFormat } from '@/lib/music/import/detect'

describe('detectFormat', () => {
  it('detects by extension', () => {
    expect(detectFormat({ filename: 'tune.abc' })).toBe('abc')
    expect(detectFormat({ filename: 'tune.mid' })).toBe('midi')
    expect(detectFormat({ filename: 'tune.MIDI' })).toBe('midi')
    expect(detectFormat({ filename: 'tune.json' })).toBe('json')
    // Uncompressed MusicXML now imports; compressed .mxl stays unsupported.
    expect(detectFormat({ filename: 'tune.musicxml' })).toBe('musicxml')
    expect(detectFormat({ filename: 'tune.xml' })).toBe('musicxml')
    expect(detectFormat({ filename: 'tune.mxl' })).toBe('xml-unsupported')
  })

  it('detects MIDI by MThd magic bytes', () => {
    const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6])
    expect(detectFormat({ bytes })).toBe('midi')
  })

  it('detects ABC by content sniff when extension is missing', () => {
    const text = 'X:1\nT:Title\nM:4/4\nK:C\nCDEF|'
    expect(detectFormat({ text })).toBe('abc')
  })

  it('detects JSON by leading {', () => {
    expect(detectFormat({ text: '{"key":"C"}' })).toBe('json')
  })

  it('reports unknown for unrecognized input', () => {
    expect(detectFormat({ text: 'just some random text' })).toBe('unknown')
  })

  it('reports xml-unsupported for leading <', () => {
    expect(detectFormat({ text: '<?xml version="1.0"?>' })).toBe('xml-unsupported')
  })
})

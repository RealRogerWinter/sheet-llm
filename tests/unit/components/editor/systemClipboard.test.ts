import { describe, it, expect, vi, afterEach } from 'vitest'
import { mirrorToSystemClipboard, readSystemClipboardEntry } from '@/components/editor/systemClipboard'
import { clipboardEntryToJSON } from '@/lib/chat/clipboard'
import type { ClipboardEntry } from '@/lib/chat/state'

const entry = {
  kind: 'events',
  events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }],
  sourceMeta: { meter: '4/4', staffIdx: 0, voiceIdx: 0, totalUnits: 8 },
} as unknown as ClipboardEntry

const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true })
}
afterEach(() => {
  if (orig) Object.defineProperty(navigator, 'clipboard', orig)
  else setClipboard(undefined)
})

describe('systemClipboard mirror (D3)', () => {
  it('mirrorToSystemClipboard writes tagged JSON when the API is present', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    await mirrorToSystemClipboard(entry)
    expect(writeText).toHaveBeenCalledWith(clipboardEntryToJSON(entry))
  })

  it('mirrorToSystemClipboard is a no-op (never throws) when the API is absent', async () => {
    setClipboard(undefined)
    await expect(mirrorToSystemClipboard(entry)).resolves.toBeUndefined()
  })

  it('mirrorToSystemClipboard swallows a rejected writeText (no permission)', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    await expect(mirrorToSystemClipboard(entry)).resolves.toBeUndefined()
  })

  it('readSystemClipboardEntry parses a tagged payload', async () => {
    setClipboard({ writeText: vi.fn(), readText: vi.fn().mockResolvedValue(clipboardEntryToJSON(entry)) })
    const out = await readSystemClipboardEntry()
    expect(out?.kind).toBe('events')
  })

  it('readSystemClipboardEntry returns null for foreign (non-tagged) text', async () => {
    setClipboard({ writeText: vi.fn(), readText: vi.fn().mockResolvedValue('hello from another app') })
    expect(await readSystemClipboardEntry()).toBeNull()
  })

  it('readSystemClipboardEntry returns null when readText rejects', async () => {
    setClipboard({ writeText: vi.fn(), readText: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await readSystemClipboardEntry()).toBeNull()
  })

  it('readSystemClipboardEntry returns null when readText is unavailable', async () => {
    setClipboard({ writeText: vi.fn() }) // write-only clipboard, no readText
    expect(await readSystemClipboardEntry()).toBeNull()
  })
})

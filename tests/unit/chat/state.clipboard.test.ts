import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, type ClipboardEntry } from '@/lib/chat/state'

describe('clipboard store slot (M28-PR-1)', () => {
  beforeEach(() => {
    useChatStore.getState().clearClipboard()
  })

  it('starts empty', () => {
    expect(useChatStore.getState().clipboard).toBeUndefined()
  })

  it('setClipboard stores the entry; clearClipboard clears it', () => {
    const entry: ClipboardEntry = {
      kind: 'events',
      events: [],
      sourceMeta: { meter: '4/4', staffIdx: 0, voiceIdx: 0, totalUnits: 0 },
    }
    useChatStore.getState().setClipboard(entry)
    expect(useChatStore.getState().clipboard).toEqual(entry)
    useChatStore.getState().clearClipboard()
    expect(useChatStore.getState().clipboard).toBeUndefined()
  })
})

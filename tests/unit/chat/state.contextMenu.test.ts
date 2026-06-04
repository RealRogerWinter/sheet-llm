import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, type ContextMenuState } from '@/lib/chat/state'

describe('context-menu store slot (M27)', () => {
  beforeEach(() => {
    useChatStore.getState().closeContextMenu()
  })

  it('starts closed (undefined)', () => {
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('openContextMenu sets the target + anchor; closeContextMenu clears it', () => {
    const state: ContextMenuState = {
      target: { kind: 'measure', measureIdx: 2, insertAfterIdx: 0, staffIdx: 0 },
      anchorX: 120,
      anchorY: 80,
    }
    useChatStore.getState().openContextMenu(state)
    expect(useChatStore.getState().contextMenu).toEqual(state)

    useChatStore.getState().closeContextMenu()
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('opening again replaces the previous target', () => {
    useChatStore.getState().openContextMenu({
      target: { kind: 'none' },
      anchorX: 0,
      anchorY: 0,
    })
    const next: ContextMenuState = {
      target: { kind: 'note', selection: { measureIdx: 1, eventIdx: 3 } },
      anchorX: 200,
      anchorY: 140,
    }
    useChatStore.getState().openContextMenu(next)
    expect(useChatStore.getState().contextMenu).toEqual(next)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { clearHighlight, handleEvent, handleFinished } from '@/components/transport/transportCursor'
import { useChatStore } from '@/lib/chat/state'

describe('transportCursor', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    // Reset relevant store slices.
    useChatStore.setState({
      isPlaying: false,
      playbackPosition: undefined,
      followPlayback: false,
      editMap: undefined,
    } as Partial<ReturnType<typeof useChatStore.getState>> as never)
  })

  it('clearHighlight removes .abcjs-note-playing from every match', () => {
    document.body.innerHTML = `
      <div class="abcjs-note abcjs-note-playing"></div>
      <div class="abcjs-note abcjs-note-playing"></div>
      <div class="abcjs-note"></div>
    `
    expect(document.querySelectorAll('.abcjs-note-playing').length).toBe(2)
    clearHighlight()
    expect(document.querySelectorAll('.abcjs-note-playing').length).toBe(0)
  })

  it('handleEvent applies .abcjs-note-playing to the event elements', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    a.classList.add('abcjs-note')
    b.classList.add('abcjs-note')
    document.body.append(a, b)

    handleEvent({ elements: [[a], [b]], startCharArray: [], type: 'event' })

    expect(a.classList.contains('abcjs-note-playing')).toBe(true)
    expect(b.classList.contains('abcjs-note-playing')).toBe(true)
  })

  it('handleEvent clears prior highlight first', () => {
    const stale = document.createElement('div')
    stale.classList.add('abcjs-note', 'abcjs-note-playing')
    const fresh = document.createElement('div')
    fresh.classList.add('abcjs-note')
    document.body.append(stale, fresh)

    handleEvent({ elements: [[fresh]], type: 'event' })

    expect(stale.classList.contains('abcjs-note-playing')).toBe(false)
    expect(fresh.classList.contains('abcjs-note-playing')).toBe(true)
  })

  it('handleFinished resets store playback state and clears highlight', () => {
    const el = document.createElement('div')
    el.classList.add('abcjs-note', 'abcjs-note-playing')
    document.body.append(el)
    useChatStore.setState({ isPlaying: true } as never)

    handleFinished()

    expect(el.classList.contains('abcjs-note-playing')).toBe(false)
    expect(useChatStore.getState().isPlaying).toBe(false)
    expect(useChatStore.getState().playbackPosition).toBeUndefined()
  })

  it('handleEvent(null) is a no-op that just clears highlight', () => {
    const el = document.createElement('div')
    el.classList.add('abcjs-note', 'abcjs-note-playing')
    document.body.append(el)
    handleEvent(null)
    expect(el.classList.contains('abcjs-note-playing')).toBe(false)
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { isContextMenuEnabled } from '@/components/editor/contextMenuFlag'

describe('isContextMenuEnabled (M27 default-on kill switch)', () => {
  const original = process.env.NEXT_PUBLIC_SL_CONTEXT_MENU

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SL_CONTEXT_MENU
    else process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = original
  })

  it('defaults to true (on) when the flag is unset', () => {
    delete process.env.NEXT_PUBLIC_SL_CONTEXT_MENU
    expect(isContextMenuEnabled()).toBe(true)
  })

  it('is disabled only by the exact kill value "off"', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'off'
    expect(isContextMenuEnabled()).toBe(false)
  })

  it('stays on for any non-"off" value', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'on'
    expect(isContextMenuEnabled()).toBe(true)
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'true'
    expect(isContextMenuEnabled()).toBe(true)
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = ''
    expect(isContextMenuEnabled()).toBe(true)
  })
})

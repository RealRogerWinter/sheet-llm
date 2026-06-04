import { describe, it, expect, afterEach } from 'vitest'
import { isClipboardEnabled } from '@/components/editor/contextMenuFlag'

describe('isClipboardEnabled (M28 default-on kill switch)', () => {
  const original = process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD
    else process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD = original
  })

  it('defaults to true (on) when the flag is unset', () => {
    delete process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD
    expect(isClipboardEnabled()).toBe(true)
  })

  it('is disabled only by the exact kill value "off"', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD = 'off'
    expect(isClipboardEnabled()).toBe(false)
  })

  it('stays on for any non-"off" value', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD = 'on'
    expect(isClipboardEnabled()).toBe(true)
    process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD = 'true'
    expect(isClipboardEnabled()).toBe(true)
  })
})

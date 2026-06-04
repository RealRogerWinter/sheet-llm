import { describe, it, expect, afterEach } from 'vitest'
import { isAiEntryEnabled } from '@/components/editor/contextMenuFlag'

describe('isAiEntryEnabled (M29 default-on kill switch)', () => {
  const original = process.env.NEXT_PUBLIC_SL_CONTEXT_AI

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SL_CONTEXT_AI
    else process.env.NEXT_PUBLIC_SL_CONTEXT_AI = original
  })

  it('defaults to true (on) when unset', () => {
    delete process.env.NEXT_PUBLIC_SL_CONTEXT_AI
    expect(isAiEntryEnabled()).toBe(true)
  })

  it('is disabled only by the exact kill value "off"', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_AI = 'off'
    expect(isAiEntryEnabled()).toBe(false)
  })

  it('stays on for any non-"off" value', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_AI = 'on'
    expect(isAiEntryEnabled()).toBe(true)
    process.env.NEXT_PUBLIC_SL_CONTEXT_AI = 'true'
    expect(isAiEntryEnabled()).toBe(true)
  })
})

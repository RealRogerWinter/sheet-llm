import { describe, it, expect } from 'vitest'
import { flattenSystemPrompt, toSystemBlocks } from '@/lib/providers/systemBlocks'

describe('systemBlocks', () => {
  it('toSystemBlocks wraps a string in a single block', () => {
    expect(toSystemBlocks('hello')).toEqual([{ text: 'hello' }])
  })

  it('toSystemBlocks passes through an existing array', () => {
    const blocks = [{ text: 'a' }, { text: 'b', cache: true }]
    expect(toSystemBlocks(blocks)).toBe(blocks)
  })

  it('flattenSystemPrompt joins blocks with double newlines for providers without per-block caching', () => {
    expect(flattenSystemPrompt([{ text: 'a' }, { text: 'b', cache: true }, { text: 'c' }])).toBe(
      'a\n\nb\n\nc',
    )
  })

  it('flattenSystemPrompt returns a string unchanged', () => {
    expect(flattenSystemPrompt('plain')).toBe('plain')
  })
})

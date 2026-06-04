import { describe, it, expect, beforeEach } from 'vitest'
import { renderAbc } from '@/lib/abc/render'

const C_MAJOR_SCALE = 'X:1\nT:C major\nM:4/4\nL:1/8\nK:C\nCDEF GABc|'

describe('renderAbc', () => {
  let target: HTMLElement

  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  it('renders an SVG into the target element', async () => {
    await renderAbc(target, C_MAJOR_SCALE)
    const svg = target.querySelector('svg')
    expect(svg).not.toBeNull()
  })

  it('renders <g> grouping elements (notes / staff parts)', async () => {
    await renderAbc(target, C_MAJOR_SCALE)
    const gs = target.querySelectorAll('svg g')
    expect(gs.length).toBeGreaterThan(0)
  })

  it('handles multiple measures without error', async () => {
    const twoBars = 'X:1\nT:Two\nM:4/4\nL:1/8\nK:C\nCDEF GABc|cBAG FEDC|'
    await renderAbc(target, twoBars)
    expect(target.querySelector('svg')).not.toBeNull()
  })
})

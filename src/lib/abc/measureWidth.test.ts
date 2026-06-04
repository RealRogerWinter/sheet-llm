import { describe, it, expect, beforeEach } from 'vitest'
import { renderScore } from './synth'

/**
 * Regression for the ragged measure-width bug: a system of quarter notes
 * rendered narrower than a system of 16th notes because abcjs justifies
 * each system independently and cannot compress a dense system below its
 * natural minimum width. `expandToWidest` (default-on in renderScore)
 * re-lays every system to the widest system's width, so all measures of
 * equal duration come out the same width and every system shares one
 * right margin.
 */

// 4 bars of quarters (system 1) then 4 bars of 16ths (system 2). The
// serializer forces a system break every 4 bars, mirroring real output.
const ABC = [
  'X:1',
  'M:4/4',
  'L:1/16',
  'K:C',
  'C4 C4 C4 C4 | C4 C4 C4 C4 | C4 C4 C4 C4 | C4 C4 C4 C4 |',
  'CCCC CCCC CCCC CCCC | CCCC CCCC CCCC CCCC | CCCC CCCC CCCC CCCC | CCCC CCCC CCCC CCCC |',
].join('\n')

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Rightmost barline x for each rendered system (post-layout). */
function systemRightEdges(visualObj: any): number[] {
  const lines = (visualObj?.lines ?? []).filter((l: any) => l.staffGroup)
  return lines.map((line: any) => {
    const voice = line.staffGroup.voices[0]
    const barXs = voice.children
      .filter((ch: any) => ch.type === 'bar')
      .map((ch: any) => ch.x as number)
    return Math.round(Math.max(...barXs))
  })
}

describe('measure-width equalization (expandToWidest)', () => {
  let target: HTMLDivElement

  beforeEach(() => {
    document.body.innerHTML = ''
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  it('default render aligns every system to the same right edge', async () => {
    const visualObj = await renderScore(target, ABC)
    const edges = systemRightEdges(visualObj)
    expect(edges.length).toBe(2)
    // Both systems must end at the same x (within sub-pixel rounding):
    // the quarter system expanded to match the wider 16th system.
    expect(Math.abs(edges[0] - edges[1])).toBeLessThanOrEqual(2)
  })

  it('opting out (expandToWidest:false) leaves the systems ragged', async () => {
    const visualObj = await renderScore(target, ABC, { expandToWidest: false })
    const edges = systemRightEdges(visualObj)
    expect(edges.length).toBe(2)
    // Without equalization the dense 16th system is measurably wider than
    // the quarter system — this is the bug the default-on flag fixes.
    expect(Math.abs(edges[0] - edges[1])).toBeGreaterThan(10)
  })

  it('equalized measures are uniform width within tolerance', async () => {
    const visualObj = await renderScore(target, ABC)
    const lines = (visualObj as any).lines.filter((l: any) => l.staffGroup)
    const allGaps: number[] = []
    for (const line of lines) {
      const barXs: number[] = line.staffGroup.voices[0].children
        .filter((ch: any) => ch.type === 'bar')
        .map((ch: any) => ch.x)
      for (let i = 1; i < barXs.length; i++) allGaps.push(barXs[i] - barXs[i - 1])
    }
    const min = Math.min(...allGaps)
    const max = Math.max(...allGaps)
    // Every measure across both systems within ~5% of each other.
    expect((max - min) / max).toBeLessThan(0.05)
  })
})

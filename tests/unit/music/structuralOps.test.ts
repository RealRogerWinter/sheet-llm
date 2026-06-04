import { describe, expect, it } from 'vitest'
import type { Score } from '@/lib/music/types'
import {
  remapScoreReferences,
  remapIndexAfterRegionReplace,
} from '@/lib/music/structuralOps'

/**
 * Tests for the pure remap helpers in structuralOps. The PR-3 review's
 * H3 fix lives here: remapScoreReferences must drop any jumpMarker
 * whose segnoRef / codaRef / toCodaRef no longer resolves after a
 * regionReplace evicts the target marker, and surface a warning via
 * the optional warnings sink rather than letting validateScore throw
 * jump_ref_missing downstream.
 */

function scoreWith(opts: Partial<Score>): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    ],
    ...opts,
  }
}

describe('remapScoreReferences — H3 dangling jumpMarker ref sweep', () => {
  it('drops jumpMarker with dangling segnoRef when Segno is removed by count=0 delete', () => {
    // Segno at measure 2 is INSIDE deleted range [2..3] with count=0
    // → remapIndexAfterRegionReplace returns null → segno dropped.
    // D.S. al Fine at measure 5 has segnoRef → must be dropped + warned.
    const initial = scoreWith({
      segnoMarkers: [{ id: 'segno00001', measureIdx: 2, side: 'start' }],
      jumpMarkers: [
        {
          id: 'jumpDSalFin',
          measureIdx: 5,
          side: 'end',
          kind: 'D.S. al Fine',
          segnoRef: 'segno00001',
        },
      ],
    })
    const warnings: string[] = []
    const next = remapScoreReferences(
      initial,
      (idx) => remapIndexAfterRegionReplace(idx, 2, 3, /* count */ 0),
      warnings,
    )
    expect(next.segnoMarkers).toBeUndefined()
    expect(next.jumpMarkers).toBeUndefined()
    expect(warnings.some((w) => w.includes('jumpDSalFin') && w.includes('segnoRef'))).toBe(true)
  })

  it('drops jumpMarker with dangling codaRef when Coda is removed', () => {
    const initial = scoreWith({
      codaMarkers: [{ id: 'codaaaaaa1', measureIdx: 3, side: 'start' }],
      jumpMarkers: [
        {
          id: 'jumpalCoda1',
          measureIdx: 2,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'codaaaaaa1',
        },
      ],
    })
    const warnings: string[] = []
    const next = remapScoreReferences(
      initial,
      (idx) => remapIndexAfterRegionReplace(idx, 3, 3, /* count */ 0),
      warnings,
    )
    expect(next.codaMarkers).toBeUndefined()
    // The D.C. al Coda's measureIdx (2) is BEFORE the removed range, so
    // it remaps cleanly to 2 — but its codaRef now dangles and it's
    // dropped by the H3 sweep.
    expect(next.jumpMarkers).toBeUndefined()
    expect(warnings.some((w) => w.includes('jumpalCoda1') && w.includes('codaRef'))).toBe(true)
  })

  it('keeps jumpMarker when all refs still resolve after remap', () => {
    const initial = scoreWith({
      segnoMarkers: [{ id: 'segno00001', measureIdx: 0, side: 'start' }],
      jumpMarkers: [
        {
          id: 'jumpDS00001',
          measureIdx: 5,
          side: 'end',
          kind: 'D.S.',
          segnoRef: 'segno00001',
        },
      ],
    })
    const warnings: string[] = []
    // Replace [2..3] with 1 measure — neither marker is inside.
    const next = remapScoreReferences(
      initial,
      (idx) => remapIndexAfterRegionReplace(idx, 2, 3, /* count */ 1),
      warnings,
    )
    expect(next.segnoMarkers).toHaveLength(1)
    expect(next.jumpMarkers).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })
})

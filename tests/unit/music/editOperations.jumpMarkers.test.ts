import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import {
  createCoda,
  createSegno,
  ensureJumpMarkerIds,
  JUMP_KINDS,
} from '@/lib/music/spans'
import type { JumpKind, Score } from '@/lib/music/types'

function fourBars(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
    ],
  }
}

describe('JUMP_KINDS source-of-truth', () => {
  it('lists the 8 jump-marker kinds from JumpKindSchema', () => {
    expect(new Set(JUMP_KINDS)).toEqual(
      new Set([
        'D.C.',
        'D.S.',
        'D.C. al Coda',
        'D.S. al Coda',
        'D.C. al Fine',
        'D.S. al Fine',
        'To Coda',
        'Fine',
      ]),
    )
    expect(JUMP_KINDS).toHaveLength(8)
  })

  it('is assignable to JumpKind (Zod schema type parity)', () => {
    for (const k of JUMP_KINDS) {
      const _check: JumpKind = k
      expect(_check).toBe(k)
    }
  })
})

describe('insertJumpMarker', () => {
  it('adds a Fine on the last measure', () => {
    const next = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    expect(next.jumpMarkers).toHaveLength(1)
    expect(next.jumpMarkers![0].kind).toBe('Fine')
    expect(next.jumpMarkers![0].measureIdx).toBe(3)
    expect(next.jumpMarkers![0].side).toBe('end')
    expect(typeof next.jumpMarkers![0].id).toBe('string')
    expect(next.jumpMarkers![0].id.length).toBeGreaterThanOrEqual(8)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a D.C. al Fine without refs', () => {
    const next = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'D.C. al Fine' },
    })
    expect(next.jumpMarkers![0].kind).toBe('D.C. al Fine')
    expect(next.jumpMarkers![0].segnoRef).toBeUndefined()
    expect(next.jumpMarkers![0].codaRef).toBeUndefined()
    // validateScore must accept ref-less *.al-Fine forms — codaRef
    // is optional on al-Fine kinds (Fine is the implicit endpoint).
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a D.C. without refs (round-trips validateScore)', () => {
    const next = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'D.C.' },
    })
    expect(next.jumpMarkers![0].kind).toBe('D.C.')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a To Coda without refs (round-trips validateScore)', () => {
    const next = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 1, side: 'end', kind: 'To Coda' },
    })
    expect(next.jumpMarkers![0].kind).toBe('To Coda')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a D.S. with a valid segnoRef', () => {
    const segno = createSegno(0, 'start')
    const sc = { ...fourBars(), segnoMarkers: [segno] }
    const next = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: {
        measureIdx: 3,
        side: 'end',
        kind: 'D.S.',
        segnoRef: segno.id,
      },
    })
    expect(next.jumpMarkers![0].segnoRef).toBe(segno.id)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a D.S. al Coda linked to Segno + Coda + To-Coda', () => {
    const segno = createSegno(0, 'start')
    const coda = createCoda(2, 'start')
    const sc = {
      ...fourBars(),
      segnoMarkers: [segno],
      codaMarkers: [coda],
    }
    const withToCoda = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 1, side: 'end', kind: 'To Coda' },
    })
    const toCodaId = withToCoda.jumpMarkers![0].id
    const withDS = applyOperation(withToCoda, {
      kind: 'insertJumpMarker',
      jumpMarker: {
        measureIdx: 3,
        side: 'end',
        kind: 'D.S. al Coda',
        segnoRef: segno.id,
        codaRef: coda.id,
        toCodaRef: toCodaId,
      },
    })
    const ds = withDS.jumpMarkers!.find((j) => j.kind === 'D.S. al Coda')
    expect(ds).toBeDefined()
    expect(ds!.segnoRef).toBe(segno.id)
    expect(ds!.codaRef).toBe(coda.id)
    expect(ds!.toCodaRef).toBe(toCodaId)
    expect(() => validateScore(withDS)).not.toThrow()
  })

  it('honors caller-supplied id (no collision)', () => {
    const next = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: {
        id: 'mycustomid',
        measureIdx: 0,
        side: 'start',
        kind: 'D.C.',
      },
    })
    expect(next.jumpMarkers![0].id).toBe('mycustomid')
  })

  it('rejects out-of-range measureIdx (high)', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertJumpMarker',
        jumpMarker: { measureIdx: 99, side: 'end', kind: 'Fine' },
      }),
    ).toThrow(/measureIdx .* out of range/)
  })

  it('rejects negative measureIdx', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertJumpMarker',
        jumpMarker: { measureIdx: -1, side: 'end', kind: 'Fine' },
      }),
    ).toThrow(/measureIdx .* out of range/)
  })

  it('rejects unrecognized kind (runtime guard mirrors Zod enum)', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertJumpMarker',
        // @ts-expect-error testing runtime guard with off-schema kind
        jumpMarker: { measureIdx: 0, side: 'end', kind: 'D.X.' },
      }),
    ).toThrow(/not a recognized JumpMarker kind/)
  })

  it('rejects id collision', () => {
    const sc = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    const existingId = sc.jumpMarkers![0].id
    expect(() =>
      applyOperation(sc, {
        kind: 'insertJumpMarker',
        jumpMarker: {
          id: existingId,
          measureIdx: 2,
          side: 'end',
          kind: 'D.C.',
        },
      }),
    ).toThrow(/collides with an existing jumpMarker/)
  })

  it('rejects unknown segnoRef', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertJumpMarker',
        jumpMarker: {
          measureIdx: 3,
          side: 'end',
          kind: 'D.S.',
          segnoRef: 'ghostsegno',
        },
      }),
    ).toThrow(/segnoRef .* does not match any SegnoMarker/)
  })

  it('rejects unknown codaRef', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertJumpMarker',
        jumpMarker: {
          measureIdx: 3,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'ghostcoda',
        },
      }),
    ).toThrow(/codaRef .* does not match any CodaMarker/)
  })

  it('rejects unknown toCodaRef', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertJumpMarker',
        jumpMarker: {
          measureIdx: 3,
          side: 'end',
          kind: 'D.S. al Coda',
          toCodaRef: 'ghosttocoda',
        },
      }),
    ).toThrow(/toCodaRef .* does not match any JumpMarker/)
  })

  it('rejects insert-time self-reference via existence check', () => {
    // A pre-minted id matching toCodaRef is REJECTED transparently
    // by the existence check: at insert time the new id is not yet
    // in the jumpMarkers[] array, so toCodaRef='X' fails the
    // "does not match any JumpMarker" guard. Pin documents the
    // path so a refactor that mints the id BEFORE the existence
    // check would surface here (and require an explicit self-ref
    // guard equivalent to the one on updateJumpMarker).
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertJumpMarker',
        jumpMarker: {
          id: 'pre-minted',
          measureIdx: 3,
          side: 'end',
          kind: 'D.C. al Coda',
          toCodaRef: 'pre-minted',
        },
      }),
    ).toThrow(/toCodaRef .* does not match any JumpMarker/)
  })

  it('preserves existing jumpMarkers when adding another', () => {
    const sc = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 1, side: 'end', kind: 'To Coda' },
    })
    const next = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    expect(next.jumpMarkers).toHaveLength(2)
    expect(next.jumpMarkers!.map((j) => j.kind)).toEqual(['To Coda', 'Fine'])
  })
})

describe('removeJumpMarker', () => {
  it('removes a jumpMarker by id', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    const id = inserted.jumpMarkers![0].id
    const next = applyOperation(inserted, { kind: 'removeJumpMarker', id })
    expect(next.jumpMarkers).toBeUndefined()
  })

  it('rejects unknown id', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'removeJumpMarker',
        id: 'notreallyid',
      }),
    ).toThrow(/not found/)
  })

  it('preserves OTHER jumpMarkers when removing one', () => {
    let sc = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 1, side: 'end', kind: 'To Coda' },
    })
    sc = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    const firstId = sc.jumpMarkers![0].id
    const next = applyOperation(sc, {
      kind: 'removeJumpMarker',
      id: firstId,
    })
    expect(next.jumpMarkers).toHaveLength(1)
    expect(next.jumpMarkers![0].kind).toBe('Fine')
  })

  it('strips dangling toCodaRef on surviving jumpMarkers', () => {
    const segno = createSegno(0, 'start')
    const coda = createCoda(2, 'start')
    let sc: Score = {
      ...fourBars(),
      segnoMarkers: [segno],
      codaMarkers: [coda],
    }
    sc = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 1, side: 'end', kind: 'To Coda' },
    })
    const toCodaId = sc.jumpMarkers![0].id
    sc = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: {
        measureIdx: 3,
        side: 'end',
        kind: 'D.S. al Coda',
        segnoRef: segno.id,
        codaRef: coda.id,
        toCodaRef: toCodaId,
      },
    })
    const next = applyOperation(sc, {
      kind: 'removeJumpMarker',
      id: toCodaId,
    })
    const ds = next.jumpMarkers!.find((j) => j.kind === 'D.S. al Coda')
    expect(ds).toBeDefined()
    expect(ds!.toCodaRef).toBeUndefined()
    // Survives validateCrossRefs — no dangling toCodaRef.
    expect(() => validateScore(next)).not.toThrow()
  })
})

describe('updateJumpMarker', () => {
  it('patches measureIdx', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    const id = inserted.jumpMarkers![0].id
    const next = applyOperation(inserted, {
      kind: 'updateJumpMarker',
      id,
      patch: { measureIdx: 2 },
    })
    expect(next.jumpMarkers![0].measureIdx).toBe(2)
    // Kind / side carry through.
    expect(next.jumpMarkers![0].kind).toBe('Fine')
    expect(next.jumpMarkers![0].side).toBe('end')
  })

  it('promotes D.C. to D.C. al Coda via patch.kind', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'D.C.' },
    })
    const id = inserted.jumpMarkers![0].id
    const next = applyOperation(inserted, {
      kind: 'updateJumpMarker',
      id,
      patch: { kind: 'D.C. al Coda' },
    })
    expect(next.jumpMarkers![0].kind).toBe('D.C. al Coda')
  })

  it('flips side from end to start', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    const id = inserted.jumpMarkers![0].id
    const next = applyOperation(inserted, {
      kind: 'updateJumpMarker',
      id,
      patch: { side: 'start' },
    })
    expect(next.jumpMarkers![0].side).toBe('start')
  })

  it('attaches segnoRef via patch (validated against score)', () => {
    // Use D.C. — segnoRef is optional on the schema and not required
    // by validateJumpMarkerRefs (which only enforces it for D.S.*),
    // so we can insert without a ref and then patch one in.
    const segno = createSegno(0, 'start')
    const sc = { ...fourBars(), segnoMarkers: [segno] }
    const inserted = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'D.C.' },
    })
    const id = inserted.jumpMarkers![0].id
    const next = applyOperation(inserted, {
      kind: 'updateJumpMarker',
      id,
      patch: { segnoRef: segno.id },
    })
    expect(next.jumpMarkers![0].segnoRef).toBe(segno.id)
  })

  it('null clears segnoRef on a D.C. (kind that does not require it)', () => {
    // D.C. doesn't require segnoRef, so clearing is a legal final state.
    // D.S. kinds REQUIRE segnoRef; clearing them produces an invalid
    // score and is intentionally caught by validateJumpMarkerRefs.
    const segno = createSegno(0, 'start')
    const sc = { ...fourBars(), segnoMarkers: [segno] }
    const inserted = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: {
        measureIdx: 3,
        side: 'end',
        kind: 'D.C.',
        segnoRef: segno.id,
      },
    })
    const id = inserted.jumpMarkers![0].id
    const next = applyOperation(inserted, {
      kind: 'updateJumpMarker',
      id,
      patch: { segnoRef: null },
    })
    expect(next.jumpMarkers![0].segnoRef).toBeUndefined()
  })

  it('null clears codaRef', () => {
    const coda = createCoda(2, 'start')
    const sc = { ...fourBars(), codaMarkers: [coda] }
    const inserted = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: {
        measureIdx: 3,
        side: 'end',
        kind: 'D.C. al Coda',
        codaRef: coda.id,
      },
    })
    const id = inserted.jumpMarkers![0].id
    const next = applyOperation(inserted, {
      kind: 'updateJumpMarker',
      id,
      patch: { codaRef: null },
    })
    expect(next.jumpMarkers![0].codaRef).toBeUndefined()
  })

  it('rejects update of unknown id', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'updateJumpMarker',
        id: 'doesnotexist',
        patch: { measureIdx: 1 },
      }),
    ).toThrow(/not found/)
  })

  it('rejects out-of-range measureIdx in patch', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    const id = inserted.jumpMarkers![0].id
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateJumpMarker',
        id,
        patch: { measureIdx: 99 },
      }),
    ).toThrow(/measureIdx .* out of range/)
  })

  it('rejects unknown segnoRef in patch', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'D.C.' },
    })
    const id = inserted.jumpMarkers![0].id
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateJumpMarker',
        id,
        patch: { segnoRef: 'ghostsegno' },
      }),
    ).toThrow(/segnoRef .* does not match any SegnoMarker/)
  })

  it('rejects unrecognized kind in patch', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'Fine' },
    })
    const id = inserted.jumpMarkers![0].id
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateJumpMarker',
        id,
        // @ts-expect-error testing runtime guard with off-schema kind
        patch: { kind: 'D.X.' },
      }),
    ).toThrow(/not a recognized JumpMarker kind/)
  })

  it('rejects self-referential toCodaRef in patch', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 3, side: 'end', kind: 'D.C. al Coda' },
    })
    const id = inserted.jumpMarkers![0].id
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateJumpMarker',
        id,
        patch: { toCodaRef: id },
      }),
    ).toThrow(/self-reference/)
  })

  it('permits two-hop toCodaRef cycles (cycle detection deferred to expand resolver)', () => {
    // A→B→A cycles are NOT rejected at the edit-op layer: each
    // individual ref-existence check passes, and validateCrossRefs
    // also doesn't walk the chain. M18-PR-3 ships the expand() linear
    // resolver which IS where cycle detection lives — pinning here
    // documents that the current op layer is intentionally one-hop.
    const sc = applyOperation(fourBars(), {
      kind: 'insertJumpMarker',
      jumpMarker: { measureIdx: 1, side: 'end', kind: 'To Coda' },
    })
    const aId = sc.jumpMarkers![0].id
    const sc2 = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: {
        measureIdx: 2,
        side: 'end',
        kind: 'D.C. al Coda',
        toCodaRef: aId,
      },
    })
    const bId = sc2.jumpMarkers![1].id
    // Now patch A to point back at B → A→B→A cycle.
    const cycled = applyOperation(sc2, {
      kind: 'updateJumpMarker',
      id: aId,
      patch: { toCodaRef: bId },
    })
    expect(cycled.jumpMarkers![0].toCodaRef).toBe(bId)
    expect(cycled.jumpMarkers![1].toCodaRef).toBe(aId)
    // validateScore still accepts — refs each exist; M18-PR-3 will
    // reject at expand-time.
    expect(() => validateScore(cycled)).not.toThrow()
  })

  it('empty patch carries all fields (no-op)', () => {
    const segno = createSegno(0, 'start')
    const sc = { ...fourBars(), segnoMarkers: [segno] }
    const inserted = applyOperation(sc, {
      kind: 'insertJumpMarker',
      jumpMarker: {
        measureIdx: 3,
        side: 'end',
        kind: 'D.S.',
        segnoRef: segno.id,
      },
    })
    const id = inserted.jumpMarkers![0].id
    const next = applyOperation(inserted, {
      kind: 'updateJumpMarker',
      id,
      patch: {},
    })
    expect(next.jumpMarkers![0].measureIdx).toBe(3)
    expect(next.jumpMarkers![0].side).toBe('end')
    expect(next.jumpMarkers![0].kind).toBe('D.S.')
    expect(next.jumpMarkers![0].segnoRef).toBe(segno.id)
  })
})

describe('ensureJumpMarkerIds', () => {
  it('backfills ids on jumpMarkers missing them', () => {
    const input = {
      jumpMarkers: [
        { measureIdx: 0, side: 'end', kind: 'Fine' },
        { id: 'existingid', measureIdx: 1, side: 'end', kind: 'D.C.' },
      ],
    }
    ensureJumpMarkerIds(input)
    expect(typeof input.jumpMarkers[0].id).toBe('string')
    expect((input.jumpMarkers[0] as { id: string }).id.length).toBeGreaterThanOrEqual(8)
    expect(input.jumpMarkers[1].id).toBe('existingid')
  })

  it('rejects short pre-existing id and mints fresh', () => {
    const input = {
      jumpMarkers: [{ id: 'abc', measureIdx: 0, side: 'end', kind: 'Fine' }],
    }
    ensureJumpMarkerIds(input)
    expect(input.jumpMarkers[0].id).not.toBe('abc')
    expect((input.jumpMarkers[0] as { id: string }).id.length).toBeGreaterThanOrEqual(8)
  })

  it('is safe on non-Score inputs (defensive no-op)', () => {
    expect(ensureJumpMarkerIds(undefined)).toBeUndefined()
    expect(ensureJumpMarkerIds(null)).toBeNull()
    expect(ensureJumpMarkerIds({})).toEqual({})
    expect(ensureJumpMarkerIds({ jumpMarkers: 'not an array' })).toEqual({
      jumpMarkers: 'not an array',
    })
    expect(ensureJumpMarkerIds(42)).toBe(42)
    expect(ensureJumpMarkerIds('hello')).toBe('hello')
  })

  it('returns the same object reference (mutates in place)', () => {
    const input = {
      jumpMarkers: [{ measureIdx: 0, side: 'end', kind: 'Fine' }],
    }
    expect(ensureJumpMarkerIds(input)).toBe(input)
  })
})

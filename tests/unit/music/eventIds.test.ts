import { describe, it, expect } from 'vitest'
import { createEventId, deriveEventId, ensureEventIds } from '@/lib/music/eventIds'
import { EventIdSchema } from '@/lib/music/types'

describe('createEventId', () => {
  it('returns a 10-character string within the EventIdSchema bounds', () => {
    const id = createEventId()
    expect(id).toHaveLength(10)
    expect(() => EventIdSchema.parse(id)).not.toThrow()
  })

  it('produces unique IDs across many calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(createEventId())
    expect(ids.size).toBe(1000)
  })
})

describe('deriveEventId', () => {
  const path0 = { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 }
  const evC = { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }

  it('returns a 10-character string passing schema bounds', () => {
    const id = deriveEventId(evC, path0)
    expect(id).toHaveLength(10)
    expect(() => EventIdSchema.parse(id)).not.toThrow()
  })

  it('is deterministic: same content + path → same ID', () => {
    const id1 = deriveEventId(evC, path0)
    const id2 = deriveEventId(evC, path0)
    expect(id1).toBe(id2)
  })

  it('distinguishes identical events at different positions', () => {
    const id1 = deriveEventId(evC, { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 })
    const id2 = deriveEventId(evC, { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1 })
    expect(id1).not.toBe(id2)
  })

  it('distinguishes different content at the same position', () => {
    const id1 = deriveEventId(evC, path0)
    const id2 = deriveEventId({ pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' }, path0)
    expect(id1).not.toBe(id2)
  })

  it("prefixes derived IDs with 'm' so migrated events are visually distinguishable", () => {
    expect(deriveEventId(evC, path0).startsWith('m')).toBe(true)
  })

  it('handles rest events (step="rest")', () => {
    const rest = { pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }
    expect(() => deriveEventId(rest, path0)).not.toThrow()
    expect(deriveEventId(rest, path0)).toHaveLength(10)
  })

  it('handles events with no pitches array', () => {
    expect(() => deriveEventId({ duration: 'quarter' }, path0)).not.toThrow()
  })

  it('handles events with both pitches AND duration missing', () => {
    expect(() => deriveEventId({}, path0)).not.toThrow()
    expect(deriveEventId({}, path0)).toHaveLength(10)
  })

  it('tolerates non-array pitches (e.g., a corrupt string value) without throwing', () => {
    expect(() => deriveEventId({ pitches: 'C4' as unknown as undefined, duration: 'quarter' }, path0)).not.toThrow()
    expect(() => deriveEventId({ pitches: 42 as unknown as undefined, duration: 'quarter' }, path0)).not.toThrow()
    expect(() => deriveEventId({ pitches: {} as unknown as undefined, duration: 'quarter' }, path0)).not.toThrow()
  })

  it('tolerates null entries inside the pitches array without throwing', () => {
    const id = deriveEventId(
      { pitches: [null as unknown as { step: string; octave: number }, { step: 'C', octave: 4 }], duration: 'quarter' },
      path0,
    )
    expect(id).toHaveLength(10)
  })

  it("treats accidental:'none' and accidental:undefined as the same content", () => {
    const idNone = deriveEventId(
      { pitches: [{ step: 'C', octave: 4, accidental: 'none' }], duration: 'quarter' },
      path0,
    )
    const idMissing = deriveEventId(
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      path0,
    )
    expect(idNone).toBe(idMissing)
  })

  it("treats accidental:'sharp' as distinct from accidental:'none' / missing", () => {
    const idSharp = deriveEventId(
      { pitches: [{ step: 'C', octave: 4, accidental: 'sharp' }], duration: 'quarter' },
      path0,
    )
    const idNone = deriveEventId(
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      path0,
    )
    expect(idSharp).not.toBe(idNone)
  })

  it('produces a pinned snapshot value for a canonical input (regression guard)', () => {
    // Golden value pins the FNV-1a constants, content layout, and tail
    // computation. If this changes, every previously-migrated score in
    // production gets renumbered — failing this test forces the change
    // to be conscious.
    const id = deriveEventId(evC, path0)
    expect(id).toBe('m086ff028i')
  })
})

describe('ensureEventIds', () => {
  function q(step: string, idMaybe?: string) {
    const ev: Record<string, unknown> = {
      pitches: [{ step, octave: 4 }],
      duration: 'quarter',
    }
    if (idMaybe) ev.id = idMaybe
    return ev
  }

  it('fills in IDs on a single-staff single-voice score', () => {
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [q('C'), q('D'), q('E'), q('F')] }],
    }
    ensureEventIds(score)
    for (const ev of score.measures[0].events) {
      expect(typeof (ev as Record<string, unknown>).id).toBe('string')
      expect(((ev as Record<string, unknown>).id as string).length).toBeGreaterThanOrEqual(8)
    }
  })

  it('preserves existing IDs and only fills missing ones', () => {
    const fixedId = 'fixedid_42'
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [q('C', fixedId), q('D'), q('E'), q('F')] }],
    }
    ensureEventIds(score)
    const events = score.measures[0].events as Array<Record<string, unknown>>
    expect(events[0].id).toBe(fixedId)
    expect(typeof events[1].id).toBe('string')
    expect(events[1].id).not.toBe(fixedId)
  })

  it('preserves an 8-character ID (lower bound)', () => {
    const id8 = '01234567'
    const score = { key: 'C', meter: '4/4', measures: [{ events: [q('C', id8)] }] }
    ensureEventIds(score)
    expect((score.measures[0].events[0] as Record<string, unknown>).id).toBe(id8)
  })

  it('preserves a 16-character ID (upper bound)', () => {
    const id16 = '0123456789abcdef'
    const score = { key: 'C', meter: '4/4', measures: [{ events: [q('C', id16)] }] }
    ensureEventIds(score)
    expect((score.measures[0].events[0] as Record<string, unknown>).id).toBe(id16)
  })

  it('REPLACES a 7-character ID (below schema minimum)', () => {
    const tooShort = '0123456'
    const score = { key: 'C', meter: '4/4', measures: [{ events: [q('C', tooShort)] }] }
    ensureEventIds(score)
    const newId = (score.measures[0].events[0] as Record<string, unknown>).id as string
    expect(newId).not.toBe(tooShort)
    expect(newId.length).toBeGreaterThanOrEqual(8)
    expect(newId.length).toBeLessThanOrEqual(16)
  })

  it('REPLACES a 17-character ID (above schema maximum) so subsequent Zod parse accepts the score', () => {
    const tooLong = '12345678901234567' // 17 chars
    const score = { key: 'C', meter: '4/4', measures: [{ events: [q('C', tooLong)] }] }
    ensureEventIds(score)
    const newId = (score.measures[0].events[0] as Record<string, unknown>).id as string
    expect(newId).not.toBe(tooLong)
    expect(newId.length).toBeLessThanOrEqual(16)
  })

  it('walks extraVoices on the primary staff', () => {
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [q('C'), q('D'), q('E'), q('F')] }],
      extraVoices: [{ measures: [{ events: [q('E'), q('F'), q('G'), q('A')] }] }],
    }
    ensureEventIds(score)
    const primaryIds = (score.measures[0].events as Array<Record<string, unknown>>).map((e) => e.id)
    const voice1Ids = (score.extraVoices[0].measures[0].events as Array<Record<string, unknown>>).map((e) => e.id)
    expect(new Set([...primaryIds, ...voice1Ids]).size).toBe(8)
  })

  it('walks secondStaff and its extraVoices', () => {
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [q('C')] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [q('C')] }],
        extraVoices: [{ measures: [{ events: [q('C')] }] }],
      },
    }
    ensureEventIds(score)
    const primaryId = (score.measures[0].events[0] as Record<string, unknown>).id
    const s2PrimaryId = (score.secondStaff.measures[0].events[0] as Record<string, unknown>).id
    const s2Voice1Id = (score.secondStaff.extraVoices[0].measures[0].events[0] as Record<string, unknown>).id
    expect(primaryId).not.toBe(s2PrimaryId)
    expect(s2PrimaryId).not.toBe(s2Voice1Id)
  })

  it('is idempotent — second pass produces the same IDs as the first', () => {
    const make = () => ({
      key: 'C',
      meter: '4/4',
      measures: [{ events: [q('C'), q('D'), q('E'), q('F')] }],
    })
    const a = make()
    const b = make()
    ensureEventIds(a)
    ensureEventIds(b)
    const aIds = (a.measures[0].events as Array<Record<string, unknown>>).map((e) => e.id)
    const bIds = (b.measures[0].events as Array<Record<string, unknown>>).map((e) => e.id)
    expect(aIds).toEqual(bIds)
  })

  it('returns the input for chaining', () => {
    const score = { key: 'C', meter: '4/4', measures: [{ events: [q('C')] }] }
    expect(ensureEventIds(score)).toBe(score)
  })

  it('tolerates non-object inputs without throwing', () => {
    expect(ensureEventIds(null)).toBeNull()
    expect(ensureEventIds(undefined)).toBeUndefined()
    expect(ensureEventIds('not a score' as unknown)).toBe('not a score')
    expect(ensureEventIds(42 as unknown)).toBe(42)
  })

  it('tolerates malformed scores (missing measures / events arrays)', () => {
    expect(() => ensureEventIds({})).not.toThrow()
    expect(() => ensureEventIds({ measures: 'not an array' })).not.toThrow()
    expect(() => ensureEventIds({ measures: [{}] })).not.toThrow()
    expect(() => ensureEventIds({ measures: [{ events: 'nope' }] })).not.toThrow()
  })
})

import { describe, it, expect } from 'vitest'
import {
  CURRENT_SCORE_SCHEMA_VERSION,
  migrateScoreToV1,
  rollbackScoreFromSidecar,
  scoreNeedsV1Migration,
} from '@/lib/music/migrateScoreV1'

describe('CURRENT_SCORE_SCHEMA_VERSION', () => {
  it('is 1 (Phase 1 just shipped)', () => {
    expect(CURRENT_SCORE_SCHEMA_VERSION).toBe(1)
  })
})

describe('migrateScoreToV1 — pure function', () => {
  const legacyScore = {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        ],
      },
    ],
  }

  it('returns original unchanged on rollback path', () => {
    const result = migrateScoreToV1(legacyScore)
    expect(result.original).toEqual(legacyScore)
  })

  it('assigns ids to every event in the migrated score', () => {
    const result = migrateScoreToV1(legacyScore)
    const events = (result.migrated as Record<string, unknown>).measures as Array<{
      events: Array<{ id?: string }>
    }>
    for (const ev of events[0].events) {
      expect(typeof ev.id).toBe('string')
      expect(ev.id!.length).toBeGreaterThanOrEqual(8)
    }
  })

  it('reports changed=true when events lacked ids', () => {
    expect(migrateScoreToV1(legacyScore).changed).toBe(true)
  })

  it('reports changed=false when all events already had ids', () => {
    const alreadyMigrated = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'already_xx', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
            { id: 'already_yy', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
    }
    expect(migrateScoreToV1(alreadyMigrated).changed).toBe(false)
  })

  it('does not mutate the input', () => {
    const original = JSON.parse(JSON.stringify(legacyScore))
    migrateScoreToV1(legacyScore)
    expect(legacyScore).toEqual(original)
  })

  it('handles extraVoices on the primary staff', () => {
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      ],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
          ],
        },
      ],
    }
    const result = migrateScoreToV1(score)
    expect(result.changed).toBe(true)
    const migrated = result.migrated as typeof score
    expect(typeof (migrated.measures[0].events[0] as Record<string, unknown>).id).toBe('string')
    expect(
      typeof (migrated.extraVoices[0].measures[0].events[0] as Record<string, unknown>).id,
    ).toBe('string')
  })

  it('handles secondStaff and its extraVoices', () => {
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
        extraVoices: [
          {
            measures: [
              { events: [{ pitches: [{ step: 'E', octave: 3 }], duration: 'whole' }] },
            ],
          },
        ],
      },
    }
    const result = migrateScoreToV1(score)
    expect(result.changed).toBe(true)
    const m = result.migrated as typeof score
    expect(typeof (m.measures[0].events[0] as Record<string, unknown>).id).toBe('string')
    expect(typeof (m.secondStaff.measures[0].events[0] as Record<string, unknown>).id).toBe('string')
    expect(
      typeof (m.secondStaff.extraVoices[0].measures[0].events[0] as Record<string, unknown>).id,
    ).toBe('string')
  })

  it('is idempotent: re-migrating produces no changes the second time', () => {
    const first = migrateScoreToV1(legacyScore)
    const second = migrateScoreToV1(first.migrated)
    expect(second.changed).toBe(false)
    expect(second.migrated).toEqual(first.migrated)
  })

  it('returns the same original ids on repeat migrations (deterministic backfill)', () => {
    const a = migrateScoreToV1(legacyScore)
    const b = migrateScoreToV1(legacyScore)
    const aEvents = (a.migrated as Record<string, unknown>).measures as Array<{
      events: Array<{ id?: string }>
    }>
    const bEvents = (b.migrated as Record<string, unknown>).measures as Array<{
      events: Array<{ id?: string }>
    }>
    expect(aEvents[0].events.map((e) => e.id)).toEqual(bEvents[0].events.map((e) => e.id))
  })

  it('backfills jumpMarker ids via ensureJumpMarkerIds wiring (M18-PR-1)', () => {
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'evt_keepid_', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          ],
        },
      ],
      jumpMarkers: [{ measureIdx: 0, side: 'end', kind: 'Fine' }],
    }
    const result = migrateScoreToV1(score)
    const m = result.migrated as { jumpMarkers: Array<{ id?: string }> }
    expect(typeof m.jumpMarkers[0].id).toBe('string')
    expect(m.jumpMarkers[0].id!.length).toBeGreaterThanOrEqual(8)
  })

  it('backfills volta ids via ensureVoltaIds wiring (M17-PR-1 regression pin)', () => {
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'evt_keepid_', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          ],
        },
      ],
      voltas: [{ startMeasureIdx: 0, endMeasureIdx: 0, endings: [1] }],
    }
    const result = migrateScoreToV1(score)
    const m = result.migrated as { voltas: Array<{ id?: string }> }
    expect(typeof m.voltas[0].id).toBe('string')
    expect(m.voltas[0].id!.length).toBeGreaterThanOrEqual(8)
  })
})

describe('scoreNeedsV1Migration', () => {
  it('returns true when any event lacks an id', () => {
    expect(
      scoreNeedsV1Migration({
        measures: [{ events: [{ pitches: [], duration: 'whole' }] }],
      }),
    ).toBe(true)
  })

  it('returns false when every event has an id', () => {
    expect(
      scoreNeedsV1Migration({
        measures: [{ events: [{ id: 'longenoughid', pitches: [], duration: 'whole' }] }],
      }),
    ).toBe(false)
  })

  it('returns false for non-object / malformed input', () => {
    expect(scoreNeedsV1Migration(null)).toBe(false)
    expect(scoreNeedsV1Migration('not a score')).toBe(false)
    expect(scoreNeedsV1Migration(42)).toBe(false)
  })

  it('inspects extraVoices and secondStaff', () => {
    expect(
      scoreNeedsV1Migration({
        measures: [{ events: [{ id: 'longenoughid', pitches: [], duration: 'whole' }] }],
        extraVoices: [
          {
            measures: [{ events: [{ pitches: [], duration: 'whole' }] }],
          },
        ],
      }),
    ).toBe(true)
  })
})

describe('rollbackScoreFromSidecar', () => {
  it('returns parsed JSON for a valid sidecar', () => {
    const stored = JSON.stringify({ foo: 1 })
    expect(rollbackScoreFromSidecar(stored)).toEqual({ foo: 1 })
  })

  it('returns null for null/empty input', () => {
    expect(rollbackScoreFromSidecar(null)).toBeNull()
    expect(rollbackScoreFromSidecar(undefined)).toBeNull()
    expect(rollbackScoreFromSidecar('')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(rollbackScoreFromSidecar('{ not json')).toBeNull()
  })
})

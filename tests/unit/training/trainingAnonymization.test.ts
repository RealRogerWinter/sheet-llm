// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Score } from '@/lib/music/types'
import { setDbForTesting } from '@/lib/db'
import { makeTestDb } from '../../factories/db'
import {
  users,
  sessions,
  messages,
  scoreVersions,
  orchestratorTurns,
  trainingPairs,
} from '@/lib/db/schema'
import { exportTrainingPairs } from '@/lib/training/trainingExport'

/**
 * SHE-18 PR6 — the anonymization invariant, asserted. Seed identity-bearing
 * values into EVERY field that touches the export join, then assert none of
 * them survive into the exported JSONL — except the two deliberately-kept
 * free-text training signals (userText, lyrics), which the policy documents as
 * a deferred-redaction surface behind the ToS gate.
 */

// Sentinels we must NEVER see in the export.
const SECRET = {
  sessionId: 'SESSION-11111111',
  userId: 'USER-22222222',
  requestId: 'REQUEST-33333333',
  error: 'ERROR-with-stack-44444444',
  messageId: 'MESSAGE-55555555',
  title: 'PERSONAL-NAME-Sarah',
  composer: 'COMPOSER-66666666',
  lyricist: 'LYRICIST-77777777',
  copyright: '© SECRET-OWNER 2026',
  annotation: 'ANNOTATION-88888888',
}
// Deliberately-kept training signal (documented free-text).
const KEPT = { userText: 'a waltz for the wedding', lyric: 'la-la-la' }

const SCORE: Score = {
  title: SECRET.title,
  composer: SECRET.composer,
  lyricist: SECRET.lyricist,
  copyright: SECRET.copyright,
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        {
          pitches: [{ step: 'C', octave: 4 }],
          duration: 'whole',
          lyrics: [{ verse: 1, syllable: KEPT.lyric }],
        },
      ],
    },
  ],
  annotations: [
    { text: SECRET.annotation, style: 'plain', target: { measureIdx: 0, position: 'above' } },
  ],
}

let db: ReturnType<typeof makeTestDb>

beforeEach(() => {
  db = makeTestDb()
  db.insert(users).values({ id: SECRET.userId, createdAt: 0, lastSeenAt: 0 }).run()
  db.insert(sessions)
    .values({ id: SECRET.sessionId, userId: SECRET.userId, createdAt: 0, updatedAt: 0, lastMessageAt: 0 })
    .run()
  db.insert(scoreVersions)
    .values({ id: 'va', sessionId: SECRET.sessionId, scoreJson: JSON.stringify(SCORE), scoreHash: 'h', source: 'llm', createdAt: 0, schemaVersion: 1 })
    .run()
  db.insert(messages)
    .values({ id: SECRET.messageId, sessionId: SECRET.sessionId, seq: 1, role: 'user', contentJson: JSON.stringify([{ type: 'text', text: KEPT.userText }]), createdAt: 0 })
    .run()
  db.insert(messages)
    .values({ id: 'ma', sessionId: SECRET.sessionId, seq: 2, role: 'assistant', contentJson: JSON.stringify([{ type: 'text', text: 'ok' }]), scoreVersionId: 'va', createdAt: 0 })
    .run()
  db.insert(orchestratorTurns)
    .values({
      id: 't1',
      sessionId: SECRET.sessionId,
      messageId: SECRET.messageId,
      requestId: SECRET.requestId,
      createdAt: 5,
      latencyMs: 1,
      finalStatus: 'ok',
      afterScoreVersionId: 'va',
      error: SECRET.error,
      replacementReasons: JSON.stringify([`title '${SECRET.title}' → 'X'`, 'key C → Am']),
    })
    .run()
  db.insert(trainingPairs).values({ id: 'tp1', turnId: 't1', sessionHash: 'opaque-hash', capturedAt: 100 }).run()
  setDbForTesting(db)
})
afterEach(() => setDbForTesting(undefined))

describe('training export anonymization invariant (SHE-18 PR6)', () => {
  it('leaks NONE of the identity/authorship sentinels into the JSONL', () => {
    // Two classes of sentinel here: the ACTIVE-redaction ones that exercise the
    // strip logic — title/composer/lyricist/copyright/annotation (redactScore)
    // and title-in-reasons (scrubReasons) — and PROJECTION GUARD-RAILS
    // (sessionId/userId/requestId/error/messageId) which the export never
    // SELECTs, so they assert the projection stays narrow against a future
    // regression that widens it. NOTE the kept musical free-text (lyrics,
    // marker.tempo_text, volta.text, span.endTempoText, userText) is
    // deliberately NOT a sentinel — it's documented as retained signal.
    const rows = exportTrainingPairs(db, {}).rows
    expect(rows).toHaveLength(1)
    const serialized = JSON.stringify(rows[0])
    for (const [field, value] of Object.entries(SECRET)) {
      expect(serialized, `leaked ${field}`).not.toContain(value)
    }
  })

  it('keeps the documented free-text training signal (userText + lyrics)', () => {
    const r = exportTrainingPairs(db, {}).rows[0]
    expect(r.userText).toBe(KEPT.userText)
    // lyrics ride along inside the (redacted-metadata) score — part of the
    // per-measure hash, so they must survive for the round-trip to hold.
    expect(JSON.stringify(r.afterScore)).toContain(KEPT.lyric)
  })

  it('keeps the opaque session hash (the only surviving session key)', () => {
    const r = exportTrainingPairs(db, {}).rows[0]
    expect(r.sessionHash).toBe('opaque-hash')
  })
})

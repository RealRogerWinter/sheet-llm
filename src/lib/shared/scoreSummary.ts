import type { Score } from '@/lib/music/types'
import { getMeasureCount, getStaffCount, getVoiceCount } from '@/lib/music/scoreAccessors'
import type { ScoreSummary } from './types'

/**
 * Produces the compact summary attached to each render_score transcript
 * turn. Shared between the server route (mapping ChatMessage[] →
 * TranscriptTurn[]) and the client (optimistic appends in
 * useSubmitPrompt and useFork), so both renders agree exactly.
 *
 * `staffCount` and `voiceCountPerStaff` describe the multi-staff /
 * multi-voice layout — chat-history UI uses them to label SATB and
 * grand-staff results ("8 bars · 2 staves · 4 voices").
 */
export function summarizeScore(score: Score): ScoreSummary {
  const staffCount = getStaffCount(score)
  const voiceCountPerStaff: number[] = []
  for (let s = 0; s < staffCount; s++) voiceCountPerStaff.push(getVoiceCount(score, s))
  return {
    title: score.title,
    key: score.key,
    meter: score.meter,
    tempo_bpm: score.tempo_bpm,
    measureCount: getMeasureCount(score),
    staffCount,
    voiceCountPerStaff,
  }
}

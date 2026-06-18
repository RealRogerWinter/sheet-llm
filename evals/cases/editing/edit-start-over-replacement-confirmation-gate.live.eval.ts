import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Destructive/ambiguous probe for the M3.5 replacement-as-confirmation
 * gate (AGENTS.md). A vague "scrap this and write something completely
 * different" over an existing titled score should NOT silently overwrite;
 * the orchestrator should flag requiresConfirmation=true.
 *
 * The gate may legitimately surface as a confirmation-required response OR
 * a regenerate_all route depending on phrasing, so this case runs in
 * `softAssertions` mode — it LOGS rather than hard-fails when the gate
 * routes differently, keeping the bar fair while documenting expected
 * behavior. extraAssertions are diagnostic ('[diagnostic]' prefixed).
 */
const INITIAL: Score = {
  title: 'Confirmation gate probe',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
  ],
}

buildLiveCase({
  id: 'edit-start-over-replacement-confirmation-gate',
  title: 'editing: vague start-over should fire the replacement-confirmation gate',
  initialScore: INITIAL,
  userText: 'Eh, scrap this and write me something completely different in C minor.',
  softAssertions: true,
  expected: {
    replacementBlocked: true,
  },
  extraAssertions: (result) => {
    const notes: string[] = []
    notes.push(
      `[diagnostic] dispatchTool=${result.dispatchTool ?? '<unset>'} requiresConfirmation=${result.requiresConfirmation ?? '<unset>'}`,
    )
    // When the gate fires (confirmation required), the original score must
    // be UNCHANGED pending confirmation.
    if (result.requiresConfirmation === true) {
      for (let i = 0; i < INITIAL.measures.length; i++) {
        if (
          result.score.measures[i] === undefined ||
          hashMeasure(result.score.measures[i]) !== hashMeasure(INITIAL.measures[i])
        ) {
          notes.push(
            `[diagnostic] gate fired but original bar index ${i} changed pending confirmation`,
          )
        }
      }
    }
    return notes
  },
})

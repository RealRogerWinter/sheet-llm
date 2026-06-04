import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * 4-bar piece in C major. User: "add 4 more bars with a i iv v
 * progression" — LOWERCASE Roman numerals strictly imply MINOR.
 *
 * Defensible model behaviors:
 *   (A) Route to extend_composition; produce i-iv-V in C MINOR;
 *       this triggers a key change → replacement-gate fires →
 *       requiresConfirmation: true (PR-4).
 *   (B) Heuristically read "i iv v" as the user's loose shorthand
 *       for "I IV V"; produce uppercase progression in C major.
 *
 * Soft-assertion case: we record the outcome but never hard-fail.
 * Useful as a model-behavior diagnostic across releases.
 */
const C_MAJOR_4_BARS: Score = {
  title: 'Lowercase test',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
  ],
}

buildLiveCase({
  id: 'lowercase-roman-ambiguity',
  title: 'destructive: lowercase i iv v ambiguity (diagnostic)',
  initialScore: C_MAJOR_4_BARS,
  userText: 'add 4 more bars with a i iv v progression',
  softAssertions: true,
  expected: {
    titlePreserved: 'Lowercase test',
  },
  extraAssertions: (result) => {
    const notes: string[] = []
    // Diagnostic — note which branch fired.
    notes.push(
      `[diagnostic] dispatchTool=${result.dispatchTool ?? '<unset>'} requiresConfirmation=${result.requiresConfirmation ?? false} key=${result.score.key} measures=${result.score.measures.length}`,
    )
    if (result.warnings && result.warnings.length > 0) {
      notes.push(`[diagnostic] warnings=${result.warnings.join('; ')}`)
    }
    return notes
  },
})

import type { Event, LyricSyllable, Score } from './types'

/**
 * Returns the lyric syllable attached to this event for the given
 * verse, or undefined if none.
 */
export function getSyllable(event: Pick<Event, 'lyrics'>, verse: number): LyricSyllable | undefined {
  return event.lyrics?.find((s) => s.verse === verse)
}

/**
 * Returns the raw syllable text for a given verse, or undefined.
 */
export function getSyllableText(event: Pick<Event, 'lyrics'>, verse: number): string | undefined {
  return getSyllable(event, verse)?.syllable
}

/**
 * Returns the verse numbers that have a syllable on this event,
 * sorted ascending. Empty array when the event has no lyrics.
 */
export function getVerseNumbers(event: Pick<Event, 'lyrics'>): number[] {
  if (!event.lyrics || event.lyrics.length === 0) return []
  return [...new Set(event.lyrics.map((s) => s.verse))].sort((a, b) => a - b)
}

/**
 * Returns true if the syllable on `event` for `verse` ends with a
 * hyphen (continuation of a multi-syllable word).
 */
export function syllableHasHyphen(event: Pick<Event, 'lyrics'>, verse: number): boolean {
  return getSyllable(event, verse)?.hyphen === true
}

/**
 * Returns true if the syllable on `event` for `verse` is the start
 * of a melisma extension (underscore-extender line).
 */
export function syllableHasExtender(event: Pick<Event, 'lyrics'>, verse: number): boolean {
  return getSyllable(event, verse)?.extender === true
}

/**
 * Returns a new Event with a syllable set or replaced for `verse`.
 * If the verse already had a syllable, it is replaced; otherwise it
 * is appended. Pure / immutable — input not mutated.
 */
export function setSyllable(
  event: Event,
  syllable: Omit<LyricSyllable, 'verse'> & { verse: number },
): Event {
  const existing = event.lyrics ?? []
  const filtered = existing.filter((s) => s.verse !== syllable.verse)
  return { ...event, lyrics: [...filtered, syllable] }
}

/**
 * Returns a new Event with the syllable for `verse` removed. If
 * the event then has no remaining syllables, the `lyrics` field is
 * dropped entirely. Pure / immutable.
 */
export function removeSyllable(event: Event, verse: number): Event {
  const existing = event.lyrics ?? []
  const filtered = existing.filter((s) => s.verse !== verse)
  if (filtered.length === 0) {
    const { lyrics, ...rest } = event
    void lyrics
    return rest
  }
  return { ...event, lyrics: filtered }
}

/**
 * Returns the highest verse number used anywhere in `score`. Returns
 * 0 if no lyrics are present. Used to size verse pickers / lyric
 * panels in the UI.
 */
export function getMaxVerse(score: Score): number {
  let max = 0
  for (const measure of score.measures) {
    for (const event of measure.events) {
      for (const s of event.lyrics ?? []) {
        if (s.verse > max) max = s.verse
      }
    }
  }
  if (score.extraVoices) {
    for (const voice of score.extraVoices) {
      for (const measure of voice.measures) {
        for (const event of measure.events) {
          for (const s of event.lyrics ?? []) {
            if (s.verse > max) max = s.verse
          }
        }
      }
    }
  }
  if (score.secondStaff) {
    for (const measure of score.secondStaff.measures) {
      for (const event of measure.events) {
        for (const s of event.lyrics ?? []) {
          if (s.verse > max) max = s.verse
        }
      }
    }
    if (score.secondStaff.extraVoices) {
      for (const voice of score.secondStaff.extraVoices) {
        for (const measure of voice.measures) {
          for (const event of measure.events) {
            for (const s of event.lyrics ?? []) {
              if (s.verse > max) max = s.verse
            }
          }
        }
      }
    }
  }
  return max
}

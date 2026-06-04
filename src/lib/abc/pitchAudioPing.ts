import type { Step } from '@/lib/music/types'

const STEP_TO_SEMITONES_FROM_C: Record<Exclude<Step, 'rest'>, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
}

const ACCIDENTAL_SEMITONES: Record<string, number> = {
  sharp: 1, flat: -1, dblsharp: 2, dblflat: -2, natural: 0, none: 0,
}

export function pitchToFrequency(
  step: Step,
  octave: number,
  accidental?: string,
): number {
  if (step === 'rest') return 0
  const base = STEP_TO_SEMITONES_FROM_C[step]
  const adjust = accidental ? ACCIDENTAL_SEMITONES[accidental] ?? 0 : 0
  // Scientific pitch notation: C4 = MIDI 60.
  const midi = (octave + 1) * 12 + base + adjust
  return 440 * Math.pow(2, (midi - 69) / 12)
}

let audioCtx: AudioContext | undefined
let lastPlayedAt = 0
const COALESCE_MS = 80

/**
 * Play a short sine ping at the given pitch's frequency. Used to
 * give audible feedback during pitch-change edits.
 * Browser-only. No-op on the server or in jsdom.
 */
export function pitchAudioPing(step: Step, octave: number, accidental?: string): void {
  if (typeof window === 'undefined') return
  if (step === 'rest') return
  const now = Date.now()
  if (now - lastPlayedAt < COALESCE_MS) return
  lastPlayedAt = now

  try {
    if (!audioCtx) {
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      audioCtx = new AC()
    }
    const ctx = audioCtx
    const freq = pitchToFrequency(step, octave, accidental)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    osc.connect(gain)
    gain.connect(ctx.destination)
    const t = ctx.currentTime
    gain.gain.setValueAtTime(0.4, t)
    gain.gain.linearRampToValueAtTime(0, t + 0.04)
    osc.start(t)
    osc.stop(t + 0.05)
  } catch {
    // Audio context creation can fail (autoplay policy). Silent.
  }
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { buildEventTimeIndex, type EventTimeIndex } from '@/lib/music/buildEventTimeIndex'
import { clearHighlight, handleEvent, handleFinished } from './transportCursor'

// abcjs runtime types we touch
interface CreateSynthInstance {
  init: (opts: {
    visualObj: unknown
    audioContext?: AudioContext
    options?: Record<string, unknown>
  }) => Promise<unknown>
  prime: () => Promise<unknown>
  audioBuffers: AudioBuffer[]
  duration: number
}

interface TimingCallbacksInstance {
  start: (offsetPercent?: number, units?: 'percent' | 'beats' | 'seconds') => void
  stop: () => void
  pause: () => void
  setProgress: (percent: number, units: 'percent' | 'beats' | 'seconds') => void
  replaceTarget: (visualObj: unknown) => void
  lastMoment: number
  currentTime: number
  isRunning: boolean
  isPaused: boolean
}

interface AbcjsModule {
  synth: {
    supportsAudio: () => boolean
    CreateSynth: new () => CreateSynthInstance
  }
  TimingCallbacks: new (
    visualObj: unknown,
    opts: {
      qpm?: number
      beatSubdivisions?: number
      beatCallback?: (
        beatNumber: number,
        totalBeats: number,
        totalTime: number,
        position?: unknown,
      ) => void
      eventCallback?: (ev: unknown) => void
      lineEndCallback?: (...args: unknown[]) => void
    },
  ) => TimingCallbacksInstance
}

async function loadAbcjs(): Promise<AbcjsModule> {
  const mod = await import('abcjs')
  return ((mod as unknown as { default?: AbcjsModule }).default ?? mod) as unknown as AbcjsModule
}

interface VisualObjLike {
  getBpm: (tempo?: unknown) => number
  metaText?: { tempo?: unknown }
}

export interface TransportState {
  // Read-only state surfaced to React.
  isReady: boolean
  isPlaying: boolean
  isRebinding: boolean
  isSupported: boolean
  ended: boolean
  totalMs: number
  totalMeasures: number
  qpm: number
  volume: number
  muted: boolean
  /** When true, natural end loops back to the top and keeps playing. */
  repeat: boolean
  // Imperative actions
  play: () => Promise<void>
  pause: () => void
  restart: (autoPlay?: boolean) => void
  seekPercent: (p: number, autoPlay?: boolean) => void
  setVolume: (v: number) => void
  setMuted: (m: boolean) => void
  toggleRepeat: () => void
  // Refs exposed so the Scrubber can write directly to CSS without re-rendering.
  registerProgressFill: (el: HTMLElement | null) => void
  registerScrubberRoot: (el: HTMLElement | null) => void
}

const SCRUB_FADE_MS = 30
const REPEAT_KEY = 'sheet-llm.transportRepeat'

// abcjs pre-renders the whole tune into ONE Float32 buffer, summing every
// note additively with no clamp (place-note.js copyToChannel `+=`) and a
// per-note gain of (velocity/96) * soundFontVolumeMultiplier. For the
// default FluidR3_GM soundfont that multiplier is 3.0, so a single forte
// note already renders past +/-1.0 and a dense chord voicing sums to
// ~12-18x — the out-of-range peaks survive un-clipped in the buffer and
// hard-clip only at ctx.destination, producing static (continuous clip)
// and pops (aligned onset transients). Two-part fix:
//   1. SOUND_FONT_VOLUME_MULTIPLIER halves abcjs's 3.0 default at the
//      source, shrinking every peak (and onset transient) ~2x.
//   2. A brick-wall limiter before ctx.destination (see ensureAudioCtx)
//      ceilings the adaptive residual so nothing reaches the DAC clipped.
// Together they kill the dense-polyphony static without gutting loudness
// of sparse pieces (the limiter only engages near the ceiling).
const SOUND_FONT_VOLUME_MULTIPLIER = 1.5

/**
 * Natural-end probe for an `AudioBufferSourceNode.onended` callback.
 * abcjs's synth emits no "ended" event, so the engine discriminates a
 * real end from a manual `stop()` by comparing elapsed audio time to the
 * tune duration (with a small slack). Pure + exported so the threshold is
 * unit-testable without a Web Audio context.
 */
function isNaturalEnd(elapsedSec: number, durationSec: number): boolean {
  return elapsedSec + 0.05 >= durationSec
}

export function useTransport(visualObj: unknown | undefined): TransportState {
  const abcjsRef = useRef<AbcjsModule | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const limiterRef = useRef<DynamicsCompressorNode | null>(null)
  // Per-play envelope gain (source → env → master gain). Recreated each
  // doPlay() so fade-in and a previous play's fade-out never share a node.
  const envGainRef = useRef<GainNode | null>(null)
  const synthRef = useRef<CreateSynthInstance | null>(null)
  const timingRef = useRef<TimingCallbacksInstance | null>(null)
  const sourcesRef = useRef<AudioBufferSourceNode[]>([])
  const playStartCtxTimeRef = useRef<number>(0)
  const pausedAtSecRef = useRef<number>(0)
  const startedAtSecRef = useRef<number>(0)
  const progressFillRef = useRef<HTMLElement | null>(null)
  const scrubberRootRef = useRef<HTMLElement | null>(null)
  const timeIndexRef = useRef<EventTimeIndex | undefined>(undefined)
  const lastPlayRequestIdRef = useRef<number | undefined>(undefined)
  const totalMeasuresRef = useRef(0)
  const userVolumeRef = useRef(0.85)
  // Read inside the module-scoped `onended` closure at fire-time, so a
  // mid-playback toggle takes effect on the next natural end.
  const repeatRef = useRef(false)

  const editMap = useChatStore((s) => s.editMap)
  const playRequest = useChatStore((s) => s.playRequest)

  const [isReady, setIsReady] = useState(false)
  const [isSupported, setIsSupported] = useState(true)
  const [isPlaying, setIsPlayingLocal] = useState(false)
  const [isRebinding, setIsRebinding] = useState(false)
  const [ended, setEnded] = useState(false)
  const [totalMs, setTotalMs] = useState(0)
  const [totalMeasures, setTotalMeasures] = useState(0)
  const [qpm, setQpm] = useState(120)
  const [volumeState, setVolumeState] = useState(0.85)
  const [mutedState, setMutedState] = useState(false)
  const [repeatState, setRepeatState] = useState(false)

  const setIsPlayingBoth = useCallback((v: boolean) => {
    setIsPlayingLocal(v)
    useChatStore.getState().setPlaying(v)
  }, [])

  // Lazy AudioContext. Created on the first play() call from a user
  // gesture so the browser autoplay policy is satisfied.
  const ensureAudioCtx = useCallback((): AudioContext | null => {
    if (audioCtxRef.current) return audioCtxRef.current
    if (typeof window === 'undefined') return null
    const AC: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    const ctx = new AC()
    const gain = ctx.createGain()
    gain.gain.value = mutedState ? 0 : userVolumeRef.current

    // Brick-wall limiter inserted between the master gain and the
    // destination. The summed buffer can still peak above +/-1.0 on dense
    // voicings even after SOUND_FONT_VOLUME_MULTIPLIER; those peaks are
    // preserved un-clipped in the Float32 buffer, so a node here operates
    // on the true signal and ceilings it before the DAC ever hard-clips.
    // Config = transparent limiter, not gentle compression:
    //   threshold -1.5 dBFS  → engage just below full scale
    //   knee 0               → hard knee (brick wall), not soft compression
    //   ratio 20:1           → effectively limiting
    //   attack 1 ms          → fast enough to catch chord onsets
    //   release 100 ms       → no audible pumping on sparse single notes
    // It only acts near the ceiling, so sparse pieces pass through nearly
    // unchanged. setVolume/setMuted keep targeting `gain` (before the
    // limiter), so user volume also controls how hard the limiter works.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -1.5
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.1
    gain.connect(limiter)
    limiter.connect(ctx.destination)

    audioCtxRef.current = ctx
    gainRef.current = gain
    limiterRef.current = limiter
    return ctx
  }, [mutedState])

  const writeProgressFraction = useCallback((frac: number) => {
    const el = progressFillRef.current
    if (el) el.style.setProperty('--p', String(Math.max(0, Math.min(1, frac))))
  }, [])

  // Rebuild synth + timing whenever visualObj changes. Preserves the
  // edit-during-play restore: if we were playing, record offset, tear
  // down sources, reinit, then resume from the same offset.
  useEffect(() => {
    // The state resets here are responses to an external system
    // (abcjs tune) going away or being replaced — synchronizing React
    // with an external resource, which is the canonical case for
    // setState-in-effect.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!visualObj) {
      stopSources()
      const t = timingRef.current
      if (t) {
        try {
          t.stop()
        } catch {
          // ignore
        }
      }
      timingRef.current = null
      synthRef.current = null
      setIsReady(false)
      setTotalMs(0)
      setTotalMeasures(0)
      writeProgressFraction(0)
      setIsPlayingBoth(false)
      return
    }

    let cancelled = false
    setIsRebinding(true)
    /* eslint-enable react-hooks/set-state-in-effect */
    const wasPlaying = isPlaying
    const resumeAtSec = isPlaying ? currentSec() : pausedAtSecRef.current
    // Fade out the old tune's audio while the new synth (re)builds, so an
    // edit mid-playback doesn't click. resumeAtSec is already captured above.
    stopSources({ fade: true })
    if (timingRef.current) {
      try {
        timingRef.current.stop()
      } catch {
        /* ignore */
      }
    }

    async function rebuild() {
      try {
        if (!abcjsRef.current) abcjsRef.current = await loadAbcjs()
        if (cancelled) return
        const abcjs = abcjsRef.current

        if (!abcjs.synth.supportsAudio()) {
          setIsSupported(false)
          setIsRebinding(false)
          return
        }

        const ctx = ensureAudioCtx()
        const synth = new abcjs.synth.CreateSynth()
        await synth.init({
          visualObj,
          audioContext: ctx ?? undefined,
          // chordsOff: suppress abcjs's auto-generated bass+chord
          // "boom-chick" accompaniment. abcjs synthesizes a hidden
          // rhythm track from any chord-symbol annotation ("Bb7",
          // "Eb"…) in the ABC; it's never drawn on the staff, so
          // leaving it on plays a bassline the user can't see.
          // Playback must match the notation. (Lives under `options`
          // per abcjs create-synth.js: `params = options.options`.)
          //
          // soundFontVolumeMultiplier overrides abcjs's 3.0 default for
          // FluidR3_GM (create-synth.js:50-53 reads it from this same
          // `options` object). Halving it shrinks every per-note render
          // ~2x so dense voicings don't overshoot +/-1.0 as hard; the
          // limiter in ensureAudioCtx catches the rest. See
          // SOUND_FONT_VOLUME_MULTIPLIER for the full rationale.
          options: {
            chordsOff: true,
            soundFontVolumeMultiplier: SOUND_FONT_VOLUME_MULTIPLIER,
          },
        })
        if (cancelled) return
        await synth.prime()
        if (cancelled) return

        synthRef.current = synth

        // Build timing callbacks bound to the new visualObj.
        const vo = visualObj as VisualObjLike
        const bpm = vo.getBpm(vo.metaText?.tempo)
        setQpm(bpm || 120)

        const tc = new abcjs.TimingCallbacks(visualObj, {
          qpm: bpm,
          beatSubdivisions: 4,
          eventCallback: (ev) => handleEvent(ev as never),
          beatCallback: (_b, _tb, totalTime) => {
            // totalTime here is `lastMoment` (full duration ms).
            // currentTime is on the instance.
            const tcur = timingRef.current
            if (!tcur || totalTime <= 0) return
            writeProgressFraction(tcur.currentTime / totalTime)
          },
        })
        timingRef.current = tc

        const dur = (synth.duration ?? 0) * 1000 || tc.lastMoment
        setTotalMs(dur)
        const measureCount = countMeasures(visualObj)
        totalMeasuresRef.current = measureCount
        setTotalMeasures(measureCount)

        // (Re)build the click-to-play time index.
        if (editMap) {
          try {
            timeIndexRef.current = buildEventTimeIndex(visualObj, editMap)
          } catch {
            timeIndexRef.current = undefined
          }
        }

        setIsReady(true)
        setEnded(false)
        setIsRebinding(false)

        if (wasPlaying && resumeAtSec > 0 && resumeAtSec < (synth.duration ?? 0)) {
          // Best-effort restore — start at the recorded offset.
          pausedAtSecRef.current = resumeAtSec
          void doPlay()
        } else {
          pausedAtSecRef.current = 0
          writeProgressFraction(0)
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[transport] rebuild failed', err)
          setIsRebinding(false)
        }
      }
    }

    void rebuild()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualObj])

  // editMap rebuild — only the time index, not the audio.
  useEffect(() => {
    if (!visualObj || !editMap) return
    try {
      timeIndexRef.current = buildEventTimeIndex(visualObj, editMap)
    } catch {
      timeIndexRef.current = undefined
    }
  }, [visualObj, editMap])

  function currentSec(): number {
    const ctx = audioCtxRef.current
    if (!ctx) return pausedAtSecRef.current
    if (sourcesRef.current.length === 0) return pausedAtSecRef.current
    const elapsed = ctx.currentTime - startedAtSecRef.current
    return Math.max(0, elapsed)
  }

  function stopSources(opts?: { fade?: boolean }) {
    const sources = sourcesRef.current
    const env = envGainRef.current
    const ctx = audioCtxRef.current
    // Detach the natural-end probe and drop our references first, so a
    // lingering (fading) source can never trip onended or be seen by a new
    // play that starts before the fade completes.
    for (const s of sources) s.onended = null
    sourcesRef.current = []
    envGainRef.current = null

    if (opts?.fade && ctx && env && sources.length > 0) {
      // Fade the envelope to 0 over SCRUB_FADE_MS, then stop the sources at
      // the end of the ramp. Without this, cutting the buffer at a non-zero
      // sample steps straight to silence = a click on pause/seek/edit. The
      // per-play env node is disconnected once the last source ends.
      const now = ctx.currentTime
      const end = now + SCRUB_FADE_MS / 1000
      try {
        env.gain.cancelScheduledValues(now)
        env.gain.setValueAtTime(env.gain.value, now)
        env.gain.linearRampToValueAtTime(0, end)
      } catch {
        /* ignore */
      }
      const last = sources[sources.length - 1]
      last.onended = () => {
        try {
          env.disconnect()
        } catch {
          /* ignore */
        }
      }
      for (const s of sources) {
        try {
          s.stop(end)
        } catch {
          /* ignore */
        }
      }
    } else {
      for (const s of sources) {
        try {
          s.stop()
        } catch {
          /* ignore */
        }
      }
      if (env) {
        try {
          env.disconnect()
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function doPlay(): Promise<void> {
    const synth = synthRef.current
    const ctx = ensureAudioCtx()
    const gain = gainRef.current
    if (!synth || !ctx || !gain) return
    if (synth.audioBuffers.length === 0) return

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        /* ignore */
      }
    }

    stopSources()
    const offset = pausedAtSecRef.current
    // Per-play envelope node: source → env → master gain → limiter → dest.
    // A fresh node per play means a fading-out previous play (pause/seek/
    // edit) never collides with this play's fade-in, so they crossfade
    // cleanly on separate nodes. Starts silent and ramps up below.
    const env = ctx.createGain()
    env.gain.value = 0
    env.connect(gain)
    const sources: AudioBufferSourceNode[] = []
    for (const buf of synth.audioBuffers) {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(env)
      sources.push(src)
    }
    sourcesRef.current = sources
    envGainRef.current = env
    const now = ctx.currentTime
    startedAtSecRef.current = now - offset
    playStartCtxTimeRef.current = now
    for (const s of sources) s.start(now, offset)
    // Fade in from silence so starting the buffer at a non-zero sample
    // (any offset on play/seek/loop-restart) doesn't step 0 → sample = a click.
    const fadeInEnd = now + SCRUB_FADE_MS / 1000
    try {
      env.gain.setValueAtTime(0, now)
      env.gain.linearRampToValueAtTime(1, fadeInEnd)
    } catch {
      env.gain.value = 1
    }

    sources[0].onended = () => {
      // Bail if the synth was swapped out from under us (visualObj
      // changed mid-play). The rebuild effect now owns playback state;
      // this is a superseded source whose stop() may have raced its own
      // queued `onended`. Acting on it would either loop a dead synth or
      // stomp the freshly-rebuilt state.
      if (synthRef.current !== synth) return
      // Distinguish natural end from a stop() — natural end leaves
      // currentTime at-or-past duration.
      const elapsed = (audioCtxRef.current?.currentTime ?? 0) - startedAtSecRef.current
      if (!isNaturalEnd(elapsed, synth.duration ?? Infinity)) return

      if (repeatRef.current) {
        // Repeat on: loop back to the top and keep playing. doPlay()
        // tears down the just-ended sources, rebuilds from offset 0, and
        // restarts the timing clock — so the cursor/progress reset too.
        // It reuses this render's closures (ensureAudioCtx etc.); safe
        // because they only read refs and ensureAudioCtx is idempotent.
        pausedAtSecRef.current = 0
        writeProgressFraction(0)
        void doPlay()
        return
      }

      // Natural end
      setIsPlayingBoth(false)
      setEnded(true)
      pausedAtSecRef.current = 0
      writeProgressFraction(1)
      handleFinished()
      const tc = timingRef.current
      if (tc) {
        try {
          tc.stop()
        } catch {
          /* ignore */
        }
      }
    }

    setIsPlayingBoth(true)
    setEnded(false)
    const tc = timingRef.current
    if (tc) {
      try {
        tc.stop()
      } catch {
        /* ignore */
      }
      const startPct = (synth.duration ?? 0) > 0 ? offset / (synth.duration ?? 1) : 0
      tc.start(startPct, 'percent')
    }
  }

  const play = useCallback(async () => {
    await doPlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pause = useCallback(() => {
    const synth = synthRef.current
    if (!synth) return
    pausedAtSecRef.current = currentSec()
    stopSources({ fade: true })
    setIsPlayingBoth(false)
    const tc = timingRef.current
    if (tc) {
      try {
        tc.pause()
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const seekPercent = useCallback(
    (p: number, autoPlay = false) => {
      const synth = synthRef.current
      if (!synth) return
      const clamped = Math.max(0, Math.min(1, p))
      const wasPlaying = isPlaying
      pausedAtSecRef.current = (synth.duration ?? 0) * clamped
      writeProgressFraction(clamped)
      const tc = timingRef.current
      if (tc) {
        try {
          tc.setProgress(clamped, 'percent')
        } catch {
          /* ignore */
        }
      }
      if (autoPlay || wasPlaying) {
        // Restart playback at the new offset. Fade the old position out;
        // doPlay() fades the new position in on a fresh env node, so the
        // seek crossfades instead of clicking at both ends.
        if (wasPlaying) {
          stopSources({ fade: true })
        }
        void doPlay()
      }
    },
    // doPlay is a closure over refs only; its identity isn't tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isPlaying, writeProgressFraction],
  )

  const restart = useCallback(
    (autoPlay = false) => {
      seekPercent(0, autoPlay)
    },
    [seekPercent],
  )

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    userVolumeRef.current = clamped
    setVolumeState(clamped)
    const gain = gainRef.current
    if (gain && !mutedState) gain.gain.value = clamped
  }, [mutedState])

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m)
    const gain = gainRef.current
    if (gain) gain.gain.value = m ? 0 : userVolumeRef.current
  }, [])

  const toggleRepeat = useCallback(() => {
    const next = !repeatRef.current
    repeatRef.current = next
    setRepeatState(next)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(REPEAT_KEY, next ? '1' : '0')
      } catch {
        /* private-mode / quota — in-memory state still wins */
      }
    }
  }, [])

  // Hydrate the persisted repeat preference once, after mount (reading
  // localStorage during render would risk an SSR hydration mismatch).
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      // Only '1' opts in; a missing key or any other value leaves
      // repeatRef/repeatState at their initialized default of false.
      if (window.localStorage.getItem(REPEAT_KEY) === '1') {
        repeatRef.current = true
        // Syncing React with an external system (localStorage) on mount
        // — the canonical setState-in-effect case (cf. the visualObj
        // rebuild effect above).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRepeatState(true)
      }
    } catch {
      /* private-mode / quota — ignore */
    }
  }, [])

  // playRequest watcher — preserves NoteFloatingMenu's "Play from here" flow.
  useEffect(() => {
    if (!playRequest) return
    if (playRequest.id === lastPlayRequestIdRef.current) return
    lastPlayRequestIdRef.current = playRequest.id
    const idx = timeIndexRef.current
    const synth = synthRef.current
    if (!idx || !synth || idx.totalMs === 0 || (synth.duration ?? 0) === 0) return
    const sel = playRequest.selection
    const key = `${sel.staffIdx ?? 0}:${sel.voiceIdx ?? 0}:${sel.measureIdx}:${sel.eventIdx}`
    const ms = idx.msByPosition.get(key)
    if (ms === undefined) return
    const percent = ms / idx.totalMs
    seekPercent(percent, true)
  }, [playRequest, seekPercent])

  // Cleanup on host unmount.
  useEffect(() => {
    return () => {
      stopSources()
      const tc = timingRef.current
      if (tc) {
        try {
          tc.stop()
        } catch {
          /* ignore */
        }
      }
      const gain = gainRef.current
      if (gain) {
        try {
          gain.disconnect()
        } catch {
          /* ignore */
        }
      }
      const limiter = limiterRef.current
      if (limiter) {
        try {
          limiter.disconnect()
        } catch {
          /* ignore */
        }
      }
      const ctx = audioCtxRef.current
      if (ctx && ctx.state !== 'closed') {
        // Suspend rather than close — close() is permanent and abcjs
        // may share the context with future mounts.
        try {
          void ctx.suspend()
        } catch {
          /* ignore */
        }
      }
      clearHighlight()
    }
  }, [])

  const registerProgressFill = useCallback((el: HTMLElement | null) => {
    progressFillRef.current = el
  }, [])

  const registerScrubberRoot = useCallback((el: HTMLElement | null) => {
    scrubberRootRef.current = el
  }, [])

  return {
    isReady,
    isPlaying,
    isRebinding,
    isSupported,
    ended,
    totalMs,
    totalMeasures,
    qpm,
    volume: volumeState,
    muted: mutedState,
    repeat: repeatState,
    play,
    pause,
    restart,
    seekPercent,
    setVolume,
    setMuted,
    toggleRepeat,
    registerProgressFill,
    registerScrubberRoot,
  }
}

function countMeasures(visualObj: unknown): number {
  // abcjs visualObj exposes lines → staff → voices → arrays of items.
  // A reliable measure count is the number of bar lines + the trailing
  // bar (or 1 if the score has no bars). Walk lines defensively.
  type Item = { el_type?: string }
  type Voice = Item[]
  type Staff = { voices?: Voice[] }
  type Line = { staff?: Staff[] }
  const vo = visualObj as { lines?: Line[] }
  if (!vo?.lines) return 0
  let bars = 0
  for (const line of vo.lines) {
    if (!line.staff) continue
    for (const st of line.staff) {
      if (!st.voices) continue
      // Use only the first voice to count — all voices share bar lines.
      const v = st.voices[0]
      if (!v) continue
      for (const item of v) {
        if (item.el_type === 'bar') bars++
      }
      break
    }
  }
  return Math.max(1, bars)
}

export { SCRUB_FADE_MS, isNaturalEnd }

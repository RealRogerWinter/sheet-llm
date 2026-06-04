'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import type { Accidental, Articulation, Duration, Pitch } from '@/lib/music/types'
import { smartInsertNote } from '@/lib/music/smartInsertNote'
import { getStaffEventAt, getStaffMeasureAt } from '@/lib/music/scoreAccessors'
import { getArticulations, normalizeArticulations } from '@/lib/music/articulations'
import { formatDynamic, getDynamicMarking } from '@/lib/music/dynamics'
import { diatonicAbove } from '@/lib/music/chords'
import { formatFingering, getFingering } from '@/lib/music/fingerings'
import { formatGraceNotes } from '@/lib/music/graceNotes'
import { formatChordSymbol } from '@/lib/music/chordSymbols'
import { isTrillFamilyOrnament } from '@/lib/music/ornaments'
import { activeTechniqueAt, techniquesAtPosition } from '@/lib/music/techniques'
import AnnotationPopover, { type AnnotationPopoverPatch } from './AnnotationPopover'
import ChordPalette from './ChordPalette'
import ChordSymbolPopover from './ChordSymbolPopover'
import DynamicsPopover from './DynamicsPopover'
import FingeringPopover from './FingeringPopover'
import GraceNotePopover from './GraceNotePopover'
import MarkerPopover, { type MarkerPopoverPatch } from './MarkerPopover'
import OrnamentMenuPopover, { type OrnamentMenuPatch } from './OrnamentMenuPopover'
import TechniquePopover, { type TechniquePopoverPatch } from './TechniquePopover'
import HairpinPopover, {
  type HairpinPopoverPatch,
  type HairpinEndOption,
} from './HairpinPopover'
import SlurPopover, {
  type SlurPopoverPatch,
} from './SlurPopover'
import TiePopover, { type TiePopoverPatch } from './TiePopover'
import TempoSpanPopover, {
  type TempoSpanPopoverPatch,
} from './TempoSpanPopover'
import LyricsPopover, { type LyricsPopoverPatch } from './LyricsPopover'
import BarlinePopover, { type BarlinePopoverPatch } from './BarlinePopover'
import VoltaPopover, { type VoltaPopoverPatch } from './VoltaPopover'
import JumpMarkerPopover, { type JumpMarkerPopoverPatch } from './JumpMarkerPopover'
import OctaveSpanPopover, {
  type OctaveSpanPopoverPatch,
} from './OctaveSpanPopover'
import GlissandoPopover, {
  type GlissandoPopoverPatch,
} from './GlissandoPopover'
import TrillLinePopover, {
  type TrillLinePopoverPatch,
} from './TrillLinePopover'
import TremoloBetweenPopover, {
  type TremoloBetweenPopoverPatch,
} from './TremoloBetweenPopover'
import SubMenu from './SubMenu'
import { useShiftLetterPopover } from './useShiftLetterPopover'
import {
  isGlissando,
  isHairpin,
  isOctaveSpan,
  isSlur,
  isTempoSpan,
  isTremoloBetween,
  isTrillLine,
  type HairpinKind,
  type OctaveSpanKind,
  type SlurKind,
  type TempoSpanKind,
} from '@/lib/music/spans'
import type { Span } from '@/lib/music/types'
import { getVoiceMeasures } from '@/lib/music/scoreAccessors'
import styles from './NoteFloatingMenu.module.css'

const ACCIDENTALS: Array<{ key: Accidental; label: string; title: string }> = [
  { key: 'sharp', label: '♯', title: 'Sharp (=)' },
  { key: 'natural', label: '♮', title: 'Natural (0)' },
  { key: 'flat', label: '♭', title: 'Flat (-)' },
]

const DURATIONS: Array<{ key: Duration; label: string; title: string }> = [
  { key: 'whole', label: '𝅝', title: 'Whole (6)' },
  { key: 'half', label: '𝅗𝅥', title: 'Half (5)' },
  { key: 'quarter', label: '♩', title: 'Quarter (4)' },
  { key: 'eighth', label: '♪', title: 'Eighth (3)' },
  { key: 'sixteenth', label: '𝅘𝅥𝅯', title: 'Sixteenth (2)' },
]

// Per-note marking toggles. Each button toggles the marking on/off on
// the selected event. Active-state highlighting reflects the event's
// current field so the menu shows what the score actually has.
const ARTICULATION_TOGGLES: Array<{ key: Articulation; label: string; title: string }> = [
  { key: 'staccato', label: '·', title: 'Staccato' },
  { key: 'accent', label: '>', title: 'Accent' },
  { key: 'tenuto', label: '–', title: 'Tenuto' },
  { key: 'marcato', label: '^', title: 'Marcato' },
]

function pitchLabel(p: Pitch): string {
  if (p.step === 'rest') return 'rest'
  const acc = p.accidental === 'sharp' ? '♯'
    : p.accidental === 'flat' ? '♭'
    : p.accidental === 'natural' ? '♮'
    : p.accidental === 'dblsharp' ? '𝄪'
    : p.accidental === 'dblflat' ? '𝄫'
    : ''
  return `${p.step}${acc}${p.octave}`
}

export default function NoteFloatingMenu() {
  const selection = useChatStore((s) => s.selection)
  const editedScore = useChatStore((s) => s.editedScore)
  const applyEdit = useChatStore((s) => s.applyEdit)
  const applyBalancedEdit = useChatStore((s) => s.applyBalancedEdit)
  const applyScore = useChatStore((s) => s.applyScore)
  const select = useChatStore((s) => s.select)
  const playFromSelection = useChatStore((s) => s.playFromSelection)
  const measureRangeSelection = useChatStore((s) => s.measureRangeSelection)
  const requestMeasureDelete = useChatStore((s) => s.requestMeasureDelete)
  // M27: while a right-click context menu is open, suppress the
  // left-click toolbar so the two menus never show at once. Only the
  // toolbar render is gated — the popover-dispatch subscriber (a
  // useEffect above) stays mounted, so a context-menu item that opens a
  // popover via the paletteRequest bus still works once the menu closes.
  const contextMenu = useChatStore((s) => s.contextMenu)
  const [convertOpen, setConvertOpen] = useState(false)
  const [dynamicsOpen, setDynamicsOpen] = useState(false)
  const [ornamentMenuOpen, setOrnamentMenuOpen] = useState(false)
  const [techniqueOpen, setTechniqueOpen] = useState(false)
  const [fingeringOpen, setFingeringOpen] = useState(false)
  const [graceNoteOpen, setGraceNoteOpen] = useState(false)
  const [annotationOpen, setAnnotationOpen] = useState(false)
  const [markerOpen, setMarkerOpen] = useState(false)
  const [chordSymbolOpen, setChordSymbolOpen] = useState(false)
  const [hairpinOpen, setHairpinOpen] = useState(false)
  const [slurOpen, setSlurOpen] = useState(false)
  const [tieOpen, setTieOpen] = useState(false)
  const [tempoSpanOpen, setTempoSpanOpen] = useState(false)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [barlineOpen, setBarlineOpen] = useState(false)
  const [voltaOpen, setVoltaOpen] = useState(false)
  const [jumpMarkerOpen, setJumpMarkerOpen] = useState(false)
  // M20-PR-4: octave-span + glissando popovers (8va / 8vb / 15ma / 15mb
  // and the pitch-slide line). Same event-id-gated open semantics as
  // hairpin / slur / tempoSpan — both use endpoint ids so the selected
  // event must carry an id.
  const [octaveSpanOpen, setOctaveSpanOpen] = useState(false)
  const [glissandoOpen, setGlissandoOpen] = useState(false)
  // M20-PR-5: trill-line + tremolo-between popovers. Both single-kind
  // families; trill-line emits abcjs native !trill(! tokens, tremolo-
  // between emits a "^trem." annotation. Same event-id-gating as the
  // other span popovers.
  const [trillLineOpen, setTrillLineOpen] = useState(false)
  const [tremoloBetweenOpen, setTremoloBetweenOpen] = useState(false)

  // Single piece of state for the category submenus (Articulation,
  // Dynamics & expression, Lines & spans, Text & symbols, Structure).
  // Only one submenu is open at a time; opening one closes any other.
  // The dedicated popovers above keep their own independent open flags.
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null)

  // Open a dedicated popover FROM inside a submenu: close the submenu
  // first so the popover anchors at the selection (not hidden behind
  // the submenu panel), then flip the popover's own open flag.
  const openFromSubmenu = (open: () => void) => {
    setActiveSubmenu(null)
    open()
  }

  // Dismiss on Escape — but don't intercept Escape when a child popover
  // is open; the popover handles its own escape-to-close.
  useEffect(() => {
    if (!selection) return
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.key === 'Escape' &&
        !convertOpen &&
        !dynamicsOpen &&
        !ornamentMenuOpen &&
        !techniqueOpen &&
        !fingeringOpen &&
        !graceNoteOpen &&
        !annotationOpen &&
        !markerOpen &&
        !chordSymbolOpen &&
        !hairpinOpen &&
        !slurOpen &&
        !tieOpen &&
        !tempoSpanOpen &&
        !lyricsOpen &&
        !barlineOpen &&
        !voltaOpen &&
        !jumpMarkerOpen &&
        !octaveSpanOpen &&
        !glissandoOpen &&
        !trillLineOpen &&
        !tremoloBetweenOpen &&
        activeSubmenu === null
      ) {
        select(undefined)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selection, select, convertOpen, dynamicsOpen, ornamentMenuOpen, techniqueOpen, fingeringOpen, graceNoteOpen, annotationOpen, markerOpen, chordSymbolOpen, hairpinOpen, slurOpen, tieOpen, tempoSpanOpen, lyricsOpen, barlineOpen, voltaOpen, jumpMarkerOpen, octaveSpanOpen, glissandoOpen, trillLineOpen, tremoloBetweenOpen, activeSubmenu])

  // Snapshot the measure the BarlinePopover was opened FOR
  // (M16-PR-4 review fix). The popover is measure-scoped, but the
  // user can change the live selection mid-open by clicking another
  // event. Without this snapshot, the dispatcher would route patches
  // to the LIVE measure (different from what the popover displays)
  // and the checkbox auto-emits would silently flip flags on a
  // measure the user didn't intend to edit. State (not a ref) so
  // it's safe to read during render — the lint rule
  // react-hooks/refs blocks ref-access in render.
  const [barlineTarget, setBarlineTarget] = useState<{ staffIdx: number; measureIdx: number } | null>(null)
  // Same snapshot pattern for VoltaPopover (M17-PR-4). Voltas are
  // score-level (not per-staff) but the anchor measure must be
  // captured at open time so the popover stays scoped to one target
  // for its lifetime.
  const [voltaTarget, setVoltaTarget] = useState<{ measureIdx: number } | null>(null)
  const openVoltaPopover = () => {
    if (!selection) return
    setVoltaTarget({ measureIdx: selection.measureIdx })
    setVoltaOpen(true)
  }
  // Same snapshot pattern for JumpMarkerPopover (M18-PR-5). Jump
  // markers are score-level (not per-staff), so the target shape
  // matches volta — measureIdx only.
  const [jumpMarkerTarget, setJumpMarkerTarget] = useState<{ measureIdx: number } | null>(null)
  const openJumpMarkerPopover = () => {
    if (!selection) return
    setJumpMarkerTarget({ measureIdx: selection.measureIdx })
    setJumpMarkerOpen(true)
  }
  // Same snapshot pattern for MarkerPopover (M19-PR-1 review). Markers
  // are score-level (not per-staff) — measureIdx only. Without the
  // snapshot, the existing-marker list shows the original target's
  // markers while a mid-open selection change would route the new
  // marker into the LIVE measure (different from what the popover
  // displays). The clef-change UI from M19-PR-1 amplifies this:
  // existing-list shows measure A's clefs but Apply would land on
  // measure B. Aligns Marker with the other 3 measure-scoped popovers.
  const [markerTarget, setMarkerTarget] = useState<{ measureIdx: number } | null>(null)
  const openMarkerPopover = () => {
    if (!selection) return
    setMarkerTarget({ measureIdx: selection.measureIdx })
    setMarkerOpen(true)
  }

  // M23-PR-3 / M23-PR-4 / M23-PR-5: subscribe to the command palette's
  // dispatch bus. Each `open-*` kind opens the matching popover. The
  // catalog's `available` predicate keeps these commands hidden when
  // there's no selection (and, for spans, when the selected event has
  // no id) — so a publish here generally means the preconditions hold.
  // We still guard defensively against the race (publish then
  // selection cleared before the effect runs); the target-snapshot
  // popovers (barline/volta/jumpMarker) also need the snapshot set
  // BEFORE the open flag flips.
  const paletteRequest = useChatStore((s) => s.paletteRequest)
  useEffect(() => {
    if (paletteRequest === undefined) return
    if (!selection) return
    switch (paletteRequest.kind) {
      case 'open-marker':
        // eslint-disable-next-line react-hooks/set-state-in-effect -- responding to palette dispatch bus
        setMarkerTarget({ measureIdx: selection.measureIdx })
        setMarkerOpen(true)
        break
      case 'open-dynamics':
        setDynamicsOpen(true)
        break
      case 'open-chord-symbol':
        setChordSymbolOpen(true)
        break
      case 'open-lyrics':
        setLyricsOpen(true)
        break
      case 'open-annotation':
        setAnnotationOpen(true)
        break
      case 'open-hairpin':
        setHairpinOpen(true)
        break
      case 'open-slur':
        setSlurOpen(true)
        break
      case 'open-tempo-span':
        setTempoSpanOpen(true)
        break
      case 'open-octave-span':
        setOctaveSpanOpen(true)
        break
      case 'open-glissando':
        setGlissandoOpen(true)
        break
      case 'open-trill-line':
        setTrillLineOpen(true)
        break
      case 'open-tremolo-between':
        setTremoloBetweenOpen(true)
        break
      case 'open-tie':
        setTieOpen(true)
        break
      case 'open-fingering':
        setFingeringOpen(true)
        break
      case 'open-ornament':
        setOrnamentMenuOpen(true)
        break
      case 'open-technique':
        setTechniqueOpen(true)
        break
      case 'open-grace-note':
        setGraceNoteOpen(true)
        break
      case 'open-barline':
        setBarlineTarget({
          staffIdx: selection.staffIdx ?? 0,
          measureIdx: selection.measureIdx,
        })
        setBarlineOpen(true)
        break
      case 'open-volta':
        setVoltaTarget({ measureIdx: selection.measureIdx })
        setVoltaOpen(true)
        break
      case 'open-jump-marker':
        setJumpMarkerTarget({ measureIdx: selection.measureIdx })
        setJumpMarkerOpen(true)
        break
      default:
        // Other kinds (open-score-info) are owned by EditorToolbar —
        // leave them in the slot for that subscriber to consume.
        return
    }
    useChatStore.getState().setPaletteRequest(undefined)
  }, [paletteRequest, selection])

  const openBarlinePopover = () => {
    if (!selection) return
    setBarlineTarget({
      staffIdx: selection.staffIdx ?? 0,
      measureIdx: selection.measureIdx,
    })
    setBarlineOpen(true)
  }

  // Shift+D opens the dynamics popover; Shift+P opens the performance-
  // technique popover (Dorico convention: P for "playing technique");
  // Shift+F opens the fingerings popover; Shift+O opens the ornament
  // menu; Shift+R opens the grace-notes popover (R for "gRace" — G is
  // a chord-stack letter so we pick the second-best mnemonic);
  // Shift+T opens the annotation popover (T for "Text"); Shift+M
  // opens the marker popover (M for "Marker"); Shift+H opens the
  // chord-symbol popover (H for "Harmony"). Each overrides the
  // chord-stack Shift+letter handler in useEditorKeyboard for its
  // letter — Shift+A, B, C, E, G still stack pitches; D, F, O, P, R,
  // T, M, H are now reserved (none of D/F/H/O/P/R/T/M are stack
  // letters).
  useShiftLetterPopover('D', () => setDynamicsOpen(true), { enabled: !!selection })
  useShiftLetterPopover('P', () => setTechniqueOpen(true), { enabled: !!selection })
  useShiftLetterPopover('F', () => setFingeringOpen(true), { enabled: !!selection })
  useShiftLetterPopover('O', () => setOrnamentMenuOpen(true), { enabled: !!selection })
  useShiftLetterPopover('R', () => setGraceNoteOpen(true), { enabled: !!selection })
  useShiftLetterPopover('T', () => setAnnotationOpen(true), { enabled: !!selection })
  useShiftLetterPopover('M', openMarkerPopover, { enabled: !!selection })
  useShiftLetterPopover('H', () => setChordSymbolOpen(true), { enabled: !!selection })
  // Shift+W opens the hairpin popover (W for "Wedge"; H is already
  // taken by Harmony / chord symbols, so we pick the next mnemonic
  // for crescendo/diminuendo wedges). Gated on the selected event
  // having an id — hairpin endpoints must reference an id, so opening
  // the popover for an un-id'd event would soft-deadlock (the popover
  // render guard returns null and Escape is suppressed while
  // hairpinOpen=true).
  const selectedEvent = selection && editedScore
    ? getStaffEventAt(editedScore, selection.staffIdx ?? 0, selection.measureIdx, selection.eventIdx)
    : undefined
  useShiftLetterPopover('W', () => setHairpinOpen(true), {
    enabled: !!selection && selectedEvent?.id !== undefined,
  })
  // Shift+S opens the slur popover (S for "Slur"; not a stack letter).
  // Same id-gating as hairpin — slur endpoints must reference an id.
  useShiftLetterPopover('S', () => setSlurOpen(true), {
    enabled: !!selection && selectedEvent?.id !== undefined,
  })
  // Shift+I opens the tie popover (I for "tIe" — T is taken by Text
  // annotations). The tie popover edits per-pitch tied_to_next, lv,
  // and enharmonicTie flags on the selected event PLUS the event-wide
  // tied_to_next master toggle. Unlike hairpin/slur, ties don't need
  // a remote endpoint id — they apply to the selected event in-place,
  // so no id-gating. Gated on the selected event having at least one
  // non-rest pitch since all three tie-family ops reject on rests.
  const tieEnabled =
    !!selection &&
    !!selectedEvent &&
    selectedEvent.pitches.some((p) => p.step !== 'rest')
  useShiftLetterPopover('I', () => setTieOpen(true), { enabled: tieEnabled })
  // Shift+L opens the tempo-span popover (L for "tempo Line"; J/K/L
  // are all free, L chosen as the most mnemonic). Same id-gating as
  // hairpin / slur — tempo spans use endpoint ids so the selected
  // event must carry an id.
  useShiftLetterPopover('L', () => setTempoSpanOpen(true), {
    enabled: !!selection && selectedEvent?.id !== undefined,
  })
  // M20-PR-4: Shift+U opens the octave-span popover (U for "Up an
  // octave" — 8va is the everyday case). Same endpoint-id gating
  // as hairpin / slur / tempoSpan.
  useShiftLetterPopover('U', () => setOctaveSpanOpen(true), {
    enabled: !!selection && selectedEvent?.id !== undefined,
  })
  // M20-PR-4: Shift+G opens the glissando popover (G for Glissando).
  // G is also a chord-stack letter; useShiftLetterPopover registers
  // in capture phase so stopPropagation halts the chord-stack dispatch
  // before the bubble handler runs (M4-PR-2 pattern).
  useShiftLetterPopover('G', () => setGlissandoOpen(true), {
    enabled: !!selection && selectedEvent?.id !== undefined,
  })
  // M20-PR-5: Shift+Z opens the trill-line popover (Z for the wavy
  // zig-zag glyph; no stronger mnemonic but Z is unused). Same
  // event-id gating as the other span popovers.
  useShiftLetterPopover('Z', () => setTrillLineOpen(true), {
    enabled: !!selection && selectedEvent?.id !== undefined,
  })
  // M20-PR-5: Shift+X opens the tremolo-between popover (X for the
  // crossed-line visual of the tremolo glyph between two notes).
  useShiftLetterPopover('X', () => setTremoloBetweenOpen(true), {
    enabled: !!selection && selectedEvent?.id !== undefined,
  })
  // Shift+V opens the lyrics popover (V for "Verse"; not a stack
  // letter, free in the reservation table). No id-gating — lyrics
  // are per-event flat properties, not endpoint-referenced. The
  // popover itself guards against rest-event lyrics (M15-PR-2
  // abcjs limitation).
  useShiftLetterPopover('V', () => setLyricsOpen(true), { enabled: !!selection })
  // Shift+J opens the barline popover (J for "Just-a-bar"? Pragmatic —
  // B is a chord-stack letter so the natural mnemonic is taken. J/K/N
  // (N = note-input mode), Q, U, X, Y, Z are all free; J is the
  // shortest unused. Barlines are measure-level, so no event-id
  // gating — operates on whatever measure the selection is in.
  // Routes through openBarlinePopover to snapshot the target measure.
  useShiftLetterPopover('J', openBarlinePopover, { enabled: !!selection })
  // Shift+K opens the volta popover (K — mnemonic-free but free).
  // Voltas are score-level (not per-event), so no event-id gating.
  // Routes through openVoltaPopover to snapshot the target measure.
  useShiftLetterPopover('K', openVoltaPopover, { enabled: !!selection })
  // Shift+Y opens the jumpMarker popover (Y for "Yump" — playful
  // mnemonic; J is taken by barlines, the natural "J for Jump"
  // mnemonic is unavailable). JumpMarkers are score-level (not
  // per-event), so no event-id gating. Routes through
  // openJumpMarkerPopover to snapshot the target measure.
  useShiftLetterPopover('Y', openJumpMarkerPopover, { enabled: !!selection })

  if (contextMenu) return null
  if (!selection) return null

  const event = editedScore
    ? getStaffEventAt(editedScore, selection.staffIdx ?? 0, selection.measureIdx, selection.eventIdx)
    : undefined
  const pitches = event?.pitches ?? []
  const activePitchIdx = selection.pitchIdx ?? 0
  const isChord = pitches.length > 1
  const canStack = pitches.length >= 1 && pitches.length < 6 && pitches[0]?.step !== 'rest'

  // Anchor: above the click point by ~40px; fall back to top-center.
  const ax = selection.anchorX ?? window.innerWidth / 2
  const ay = selection.anchorY ?? 120

  // Keep within the viewport horizontally. After the M-submenu
  // condensation the inline row is much narrower (core actions +
  // five category triggers), so the clamp width shrinks from ~460 to
  // ~360 — chord chips still get headroom but the row no longer needs
  // ~440px to avoid overflow.
  const left = Math.max(8, Math.min(ax - 150, window.innerWidth - 360))
  const top = Math.max(8, ay - 56)

  const topPitch = pitches[pitches.length - 1]
  const stackAbove = (intervalSteps: number) => {
    if (!topPitch || topPitch.step === 'rest') return
    try {
      const next = diatonicAbove(topPitch, intervalSteps)
      applyEdit({ kind: 'addPitchToChord', target: selection, pitch: next })
    } catch {
      /* out-of-range or rest — surface nothing for now */
    }
  }

  return (
    <div
      className={styles.menu}
      style={{ left, top }}
      role="toolbar"
      aria-label="Edit selected note"
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className={styles.button}
        title="Play from here"
        onClick={() => playFromSelection(selection)}
      >
        ▶
      </button>

      <span className={styles.divider} />

      <div className={styles.group}>
        {ACCIDENTALS.map(({ key, label, title }) => (
          <button
            key={key}
            type="button"
            className={styles.button}
            title={title}
            onClick={() => applyEdit({ kind: 'setAccidental', target: selection, accidental: key })}
          >
            {label}
          </button>
        ))}
      </div>

      <span className={styles.divider} />

      <div className={styles.group}>
        {DURATIONS.map(({ key, label, title }) => (
          <button
            key={key}
            type="button"
            className={styles.button}
            title={title}
            onClick={() =>
              applyBalancedEdit({
                kind: 'changeDurationBalanced',
                selection,
                duration: key,
              })
            }
          >
            {label}
          </button>
        ))}
      </div>

      {event && (
        <>
          <span className={styles.divider} />
          <SubMenu
            open={activeSubmenu === 'articulation'}
            label="Articulation"
            title="Staccato, accent, tenuto, marcato, fermata, breath, caesura, bowing"
            active={(() => {
              const arts = getArticulations(event)
              return (
                arts.length > 0 ||
                event.fermata !== undefined ||
                event.breathMark === true ||
                event.caesura === true ||
                event.bowing !== undefined
              )
            })()}
            ariaLabel="Articulation"
            onOpen={() => setActiveSubmenu('articulation')}
            onClose={() => setActiveSubmenu(null)}
            estimatedWidth={240}
            estimatedHeight={120}
          >
            {ARTICULATION_TOGGLES.map(({ key, label, title }) => {
              const current = getArticulations(event)
              const isActive = current.includes(key)
              return (
                <button
                  key={key}
                  type="button"
                  className={`${styles.button} ${isActive ? styles.active : ''}`}
                  title={`${title}${isActive ? ' (toggle off)' : ''}`}
                  aria-label={title}
                  aria-pressed={isActive}
                  onClick={() => {
                    // Read fresh from the store rather than the render
                    // closure. Fast Staccato → Accent before React
                    // commits would otherwise see stale `current` in
                    // the second handler and overwrite the first.
                    const liveScore = useChatStore.getState().editedScore
                    const liveEvent = liveScore
                      ? getStaffEventAt(
                          liveScore,
                          selection.staffIdx ?? 0,
                          selection.measureIdx,
                          selection.eventIdx,
                        )
                      : undefined
                    const liveCurrent = liveEvent ? getArticulations(liveEvent) : []
                    const liveActive = liveCurrent.includes(key)
                    const next = liveActive
                      ? liveCurrent.filter((a) => a !== key)
                      : (() => {
                          try {
                            return normalizeArticulations([...liveCurrent, key])
                          } catch {
                            // marcato+accent throws — surface as a no-op
                            // toolbar press; the user sees nothing change
                            // and can pick a different combination.
                            return liveCurrent
                          }
                        })()
                    applyEdit({ kind: 'setArticulations', target: selection, articulations: next })
                  }}
                >
                  {label}
                </button>
              )
            })}
            <button
              type="button"
              className={`${styles.button} ${event.fermata ? styles.active : ''}`}
              title={event.fermata ? 'Fermata (toggle off)' : 'Fermata'}
              aria-label="Fermata"
              aria-pressed={event.fermata !== undefined}
              onClick={() =>
                applyEdit(
                  event.fermata
                    ? { kind: 'setFermata', target: selection }
                    : { kind: 'setFermata', target: selection, fermata: 'standard' },
                )
              }
            >
              𝄐
            </button>
            <button
              type="button"
              className={`${styles.button} ${event.breathMark ? styles.active : ''}`}
              title={event.breathMark ? 'Breath mark (toggle off)' : 'Breath mark'}
              aria-label="Breath mark"
              aria-pressed={event.breathMark === true}
              onClick={() =>
                applyEdit({ kind: 'setBreathMark', target: selection, breathMark: !event.breathMark })
              }
            >
              ’
            </button>
            <button
              type="button"
              className={`${styles.button} ${event.caesura ? styles.active : ''}`}
              title={event.caesura ? 'Caesura (toggle off)' : 'Caesura'}
              aria-label="Caesura"
              aria-pressed={event.caesura === true}
              onClick={() =>
                applyEdit({ kind: 'setCaesura', target: selection, caesura: !event.caesura })
              }
            >
              ‖
            </button>
            <button
              type="button"
              className={`${styles.button} ${event.bowing === 'up' ? styles.active : ''}`}
              title={event.bowing === 'up' ? 'Up-bow (toggle off)' : 'Up-bow'}
              aria-label="Up-bow"
              aria-pressed={event.bowing === 'up'}
              // Bowing on a rest throws EditError downstream — disable
              // the buttons rather than letting users trigger error
              // toasts on rests where the marking is meaningless.
              disabled={event.pitches.every((p) => p.step === 'rest')}
              onClick={() =>
                applyEdit(
                  event.bowing === 'up'
                    ? { kind: 'setBowing', target: selection }
                    : { kind: 'setBowing', target: selection, bowing: 'up' },
                )
              }
            >
              V
            </button>
            <button
              type="button"
              className={`${styles.button} ${event.bowing === 'down' ? styles.active : ''}`}
              title={event.bowing === 'down' ? 'Down-bow (toggle off)' : 'Down-bow'}
              aria-label="Down-bow"
              aria-pressed={event.bowing === 'down'}
              disabled={event.pitches.every((p) => p.step === 'rest')}
              onClick={() =>
                applyEdit(
                  event.bowing === 'down'
                    ? { kind: 'setBowing', target: selection }
                    : { kind: 'setBowing', target: selection, bowing: 'down' },
                )
              }
            >
              ⊓
            </button>
          </SubMenu>

          <SubMenu
            open={activeSubmenu === 'dynamics'}
            label="Expression"
            title="Dynamics, ornament menu, performance technique"
            active={(() => {
              const hasOrnament =
                (event.ornament !== undefined && event.ornament !== 'none') ||
                event.tremolo !== undefined ||
                event.jazzInflection !== undefined
              const hasTechnique = editedScore
                ? techniquesAtPosition(
                    editedScore,
                    selection.staffIdx ?? 0,
                    selection.voiceIdx ?? 0,
                    selection.measureIdx,
                    selection.eventIdx,
                  ).length > 0 ||
                  activeTechniqueAt(
                    editedScore,
                    selection.staffIdx ?? 0,
                    selection.voiceIdx ?? 0,
                    selection.measureIdx,
                    selection.eventIdx,
                  ) !== undefined
                : false
              return getDynamicMarking(event) !== undefined || hasOrnament || hasTechnique
            })()}
            ariaLabel="Dynamics and expression"
            onOpen={() => setActiveSubmenu('dynamics')}
            onClose={() => setActiveSubmenu(null)}
            estimatedWidth={160}
            estimatedHeight={90}
          >
            <button
              type="button"
              className={`${styles.button} ${getDynamicMarking(event) ? styles.active : ''}`}
              title={getDynamicMarking(event) ? 'Edit dynamic (Shift+D)' : 'Add dynamic (Shift+D)'}
              aria-label="Dynamics"
              aria-pressed={getDynamicMarking(event) !== undefined}
              onClick={() => openFromSubmenu(() => setDynamicsOpen(true))}
            >
              𝆑
            </button>
            <button
              type="button"
              className={`${styles.button} ${
                (event.ornament && event.ornament !== 'none') ||
                event.tremolo !== undefined ||
                event.jazzInflection !== undefined
                  ? styles.active
                  : ''
              }`}
              title="Ornament, tremolo, jazz inflection (Shift+O)"
              aria-label="Ornament menu"
              aria-pressed={
                (event.ornament !== undefined && event.ornament !== 'none') ||
                event.tremolo !== undefined ||
                event.jazzInflection !== undefined
              }
              onClick={() => openFromSubmenu(() => setOrnamentMenuOpen(true))}
            >
              tr…
            </button>
            {(() => {
              // Highlight the technique button when EITHER a marker
              // lives at this exact position OR a technique is in
              // effect propagating forward from an earlier marker on
              // the same voice. Both surface via the popover.
              if (!editedScore) return null
              const staffIdx = selection.staffIdx ?? 0
              const voiceIdx = selection.voiceIdx ?? 0
              const markers = techniquesAtPosition(
                editedScore,
                staffIdx,
                voiceIdx,
                selection.measureIdx,
                selection.eventIdx,
              )
              const active = activeTechniqueAt(
                editedScore,
                staffIdx,
                voiceIdx,
                selection.measureIdx,
                selection.eventIdx,
              )
              const hasState = markers.length > 0 || active !== undefined
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasState ? styles.active : ''}`}
                  title="Performance technique (Shift+P)"
                  aria-label="Performance technique"
                  aria-pressed={hasState}
                  onClick={() => openFromSubmenu(() => setTechniqueOpen(true))}
                >
                  ◐
                </button>
              )
            })()}
          </SubMenu>

          <SubMenu
            open={activeSubmenu === 'text'}
            label="Text"
            title="Annotation, marker, chord symbol, lyrics, fingering, grace notes"
            active={(() => {
              const hasFingering = (() => {
                for (let i = 0; i < event.pitches.length; i++) {
                  if (getFingering(event, i) !== undefined) return true
                }
                return false
              })()
              const hasGrace = (event.graceNotes?.length ?? 0) > 0
              const hasChord = event.chordSymbol !== undefined
              const hasLyrics = (event.lyrics?.length ?? 0) > 0
              const hasAnnotation = editedScore
                ? (editedScore.annotations ?? []).some(
                    (a) =>
                      a.target.measureIdx === selection.measureIdx &&
                      (a.target.eventIdx ?? 0) === selection.eventIdx,
                  )
                : false
              const hasMarker = editedScore
                ? (editedScore.markers ?? []).some((m) => m.measureIdx === selection.measureIdx)
                : false
              return (
                hasFingering ||
                hasGrace ||
                hasChord ||
                hasLyrics ||
                hasAnnotation ||
                hasMarker
              )
            })()}
            ariaLabel="Text and symbols"
            onOpen={() => setActiveSubmenu('text')}
            onClose={() => setActiveSubmenu(null)}
            estimatedWidth={200}
            estimatedHeight={120}
          >
            {(() => {
              // Fingering button — active when the focused pitch has a
              // fingering. Disabled on a rest event since a fingering
              // on a rest is nonsensical and would throw EditError.
              const focusedPitchIdx = selection.pitchIdx ?? 0
              const focusedPitch = event.pitches[focusedPitchIdx]
              const hasFingering = getFingering(event, focusedPitchIdx) !== undefined
              const isRest = focusedPitch?.step === 'rest'
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasFingering ? styles.active : ''}`}
                  title={`Fingering (Shift+F)${hasFingering ? ' — open to edit or clear' : ''}`}
                  aria-label="Fingering"
                  aria-pressed={hasFingering}
                  disabled={isRest}
                  onClick={() => openFromSubmenu(() => setFingeringOpen(true))}
                >
                  ✋
                </button>
              )
            })()}
            {(() => {
              // Grace-notes button — active when the event has structured
              // graceNotes attached. Disabled on a rest event since
              // grace pitches cannot be rests (no glyph) — the schema
              // refine rejects it and applyOperation would throw.
              const hasGrace = (event.graceNotes?.length ?? 0) > 0
              const isRest = event.pitches[0]?.step === 'rest'
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasGrace ? styles.active : ''}`}
                  title={`Grace notes (Shift+R)${hasGrace ? ' — open to edit or clear' : ''}`}
                  aria-label="Grace notes"
                  aria-pressed={hasGrace}
                  disabled={isRest}
                  onClick={() => openFromSubmenu(() => setGraceNoteOpen(true))}
                >
                  ✻
                </button>
              )
            })()}
            {(() => {
              // Annotation button — active when the selected event (or
              // measure when selection is measure-level) has at least
              // one annotation attached. Annotations are score-level
              // text labels (rehearsal marks, tempo text, expression
              // markings, plain comments).
              if (!editedScore) return null
              const annotations = editedScore.annotations ?? []
              const hasAny = annotations.some(
                (a) =>
                  a.target.measureIdx === selection.measureIdx &&
                  (a.target.eventIdx ?? 0) === selection.eventIdx,
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasAny ? styles.active : ''}`}
                  title={`Annotation (Shift+T)${hasAny ? ' — open to add or remove' : ''}`}
                  aria-label="Annotation"
                  aria-pressed={hasAny}
                  onClick={() => openFromSubmenu(() => setAnnotationOpen(true))}
                >
                  ✎
                </button>
              )
            })()}
            {(() => {
              // Marker button — active when the selected measure has
              // at least one mid-piece marker (tempo / key / meter /
              // clef / metric modulation). Markers attach to MEASURE
              // boundaries (not specific events), so the filter only
              // checks measureIdx.
              if (!editedScore) return null
              const markers = editedScore.markers ?? []
              const hasAnyMarker = markers.some(
                (m) => m.measureIdx === selection.measureIdx,
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasAnyMarker ? styles.active : ''}`}
                  title={`Marker (Shift+M)${hasAnyMarker ? ' — open to add or remove' : ''}`}
                  aria-label="Marker"
                  aria-pressed={hasAnyMarker}
                  onClick={() => openFromSubmenu(openMarkerPopover)}
                >
                  ⏱
                </button>
              )
            })()}
            {(() => {
              // Chord symbol button — active when the selected event
              // has a chord symbol attached. Per-event (not per-pitch)
              // so a chord-stack with one chordSymbol shows active
              // regardless of which pitchIdx is focused. Works on
              // rest events since chord symbols are harmony labels,
              // not pitched content.
              const hasChord = event.chordSymbol !== undefined
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasChord ? styles.active : ''}`}
                  title={`Chord symbol (Shift+H)${hasChord ? ' — open to edit or clear' : ''}`}
                  aria-label="Chord symbol"
                  aria-pressed={hasChord}
                  onClick={() => openFromSubmenu(() => setChordSymbolOpen(true))}
                >
                  ♭♯
                </button>
              )
            })()}
            {(() => {
              // Lyrics button (M15-PR-4). Lyrics are per-event flat
              // properties, no endpoint-id required. Active state
              // when the event has ANY existing syllable. Disabled
              // on rest events (abcjs lyric parser skips rests; the
              // popover would show a warning).
              const hasLyrics = (event.lyrics?.length ?? 0) > 0
              const isAllRests = event.pitches.every((p) => p.step === 'rest')
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasLyrics ? styles.active : ''}`}
                  title={
                    isAllRests
                      ? 'Lyrics (Shift+V) — rest events do not render lyrics'
                      : `Lyrics (Shift+V)${hasLyrics ? ' — open to edit or remove' : ''}`
                  }
                  aria-label="Lyrics"
                  aria-pressed={hasLyrics}
                  disabled={isAllRests}
                  onClick={() => openFromSubmenu(() => setLyricsOpen(true))}
                >
                  {'Aa'}
                </button>
              )
            })()}
          </SubMenu>

          <SubMenu
            open={activeSubmenu === 'spans'}
            label="Lines"
            title="Slur, tie, hairpin, glissando, octave span, trill line, tremolo, tempo span"
            active={(() => {
              if (!editedScore || event.id === undefined) {
                // Without an event id no span can address this event,
                // but a tie applies in-place and CAN be set.
                return (
                  event.tied_to_next === true ||
                  event.pitches.some(
                    (p) =>
                      p.tied_to_next === true || p.lv === true || p.enharmonicTie === true,
                  )
                )
              }
              const eventId = event.id
              const spans = editedScore.spans ?? []
              const hasSpan = spans.some(
                (s) =>
                  (isHairpin(s) ||
                    isSlur(s) ||
                    isTempoSpan(s) ||
                    isOctaveSpan(s) ||
                    isGlissando(s) ||
                    isTrillLine(s) ||
                    isTremoloBetween(s)) &&
                  (s.startEventId === eventId || s.endEventId === eventId),
              )
              const hasTie =
                event.tied_to_next === true ||
                event.pitches.some(
                  (p) =>
                    p.tied_to_next === true || p.lv === true || p.enharmonicTie === true,
                )
              return hasSpan || hasTie
            })()}
            ariaLabel="Lines and spans"
            onOpen={() => setActiveSubmenu('spans')}
            onClose={() => setActiveSubmenu(null)}
            estimatedWidth={220}
            estimatedHeight={120}
          >
            {(() => {
              // Hairpin button — active when the selected event is an
              // endpoint (start OR end) of at least one hairpin span on
              // the same (staff, voice). The selected event must have
              // an id for hairpins to address it; un-id'd events
              // (transient pre-mint state) cannot carry hairpin
              // endpoints, so the button is disabled in that case to
              // avoid a soft-deadlock (the popover render block guards
              // on event.id !== undefined and would return null,
              // leaving hairpinOpen=true with no UI + Escape blocked).
              if (!editedScore || event.id === undefined) {
                return (
                  <button
                    type="button"
                    className={styles.button}
                    title="Hairpin (Shift+W) — selected event has no id yet"
                    aria-label="Hairpin"
                    disabled
                  >
                    {'<'}
                  </button>
                )
              }
              const spans = editedScore.spans ?? []
              const eventId = event.id
              const hasHairpin = spans.some(
                (s) => isHairpin(s) && (s.startEventId === eventId || s.endEventId === eventId),
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasHairpin ? styles.active : ''}`}
                  title={`Hairpin (Shift+W)${hasHairpin ? ' — open to edit or remove' : ''}`}
                  aria-label="Hairpin"
                  aria-pressed={hasHairpin}
                  onClick={() => openFromSubmenu(() => setHairpinOpen(true))}
                >
                  {'<'}
                </button>
              )
            })()}
            {(() => {
              // Slur button — same id-gating story as the hairpin
              // button above (un-id'd events can't carry slur endpoints
              // so the popover would soft-deadlock).
              if (!editedScore || event.id === undefined) {
                return (
                  <button
                    type="button"
                    className={styles.button}
                    title="Slur (Shift+S) — selected event has no id yet"
                    aria-label="Slur"
                    disabled
                  >
                    ⌒
                  </button>
                )
              }
              const spans = editedScore.spans ?? []
              const eventId = event.id
              const hasSlur = spans.some(
                (s) => isSlur(s) && (s.startEventId === eventId || s.endEventId === eventId),
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasSlur ? styles.active : ''}`}
                  title={`Slur (Shift+S)${hasSlur ? ' — open to edit or remove' : ''}`}
                  aria-label="Slur"
                  aria-pressed={hasSlur}
                  onClick={() => openFromSubmenu(() => setSlurOpen(true))}
                >
                  ⌒
                </button>
              )
            })()}
            {(() => {
              // Tempo-span button (M14-PR-3). Same id-gating story as
              // hairpin/slur — endpoint ids are required so an un-id'd
              // event soft-deadlocks.
              if (!editedScore || event.id === undefined) {
                return (
                  <button
                    type="button"
                    className={styles.button}
                    title="Tempo span (Shift+L) — selected event has no id yet"
                    aria-label="Tempo span"
                    disabled
                  >
                    {'⏩'}
                  </button>
                )
              }
              const spans = editedScore.spans ?? []
              const eventId = event.id
              const hasTempo = spans.some(
                (s) =>
                  isTempoSpan(s) &&
                  (s.startEventId === eventId || s.endEventId === eventId),
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasTempo ? styles.active : ''}`}
                  title={`Tempo span (Shift+L)${hasTempo ? ' — open to edit or remove' : ''}`}
                  aria-label="Tempo span"
                  aria-pressed={hasTempo}
                  onClick={() => openFromSubmenu(() => setTempoSpanOpen(true))}
                >
                  {'⏩'}
                </button>
              )
            })()}
            {(() => {
              // Octave-span button (M20-PR-4). 8va / 8vb / 15ma / 15mb
              // octave-displacement lines. Same id-gating story as the
              // other span popovers — endpoint ids are required so an
              // un-id'd event soft-deadlocks.
              if (!editedScore || event.id === undefined) {
                return (
                  <button
                    type="button"
                    className={styles.button}
                    title="Octave span (Shift+U) — selected event has no id yet"
                    aria-label="Octave span"
                    disabled
                  >
                    8va
                  </button>
                )
              }
              const spans = editedScore.spans ?? []
              const eventId = event.id
              const hasOctaveSpan = spans.some(
                (s) =>
                  isOctaveSpan(s) &&
                  (s.startEventId === eventId || s.endEventId === eventId),
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasOctaveSpan ? styles.active : ''}`}
                  title={`Octave span (Shift+U)${hasOctaveSpan ? ' — open to edit or remove' : ''}`}
                  aria-label="Octave span"
                  aria-pressed={hasOctaveSpan}
                  onClick={() => openFromSubmenu(() => setOctaveSpanOpen(true))}
                >
                  8va
                </button>
              )
            })()}
            {(() => {
              // Glissando button (M20-PR-4). Pitch slide between two
              // notes. Same id-gating story.
              if (!editedScore || event.id === undefined) {
                return (
                  <button
                    type="button"
                    className={styles.button}
                    title="Glissando (Shift+G) — selected event has no id yet"
                    aria-label="Glissando"
                    disabled
                  >
                    ╱
                  </button>
                )
              }
              const spans = editedScore.spans ?? []
              const eventId = event.id
              const hasGlissando = spans.some(
                (s) =>
                  isGlissando(s) &&
                  (s.startEventId === eventId || s.endEventId === eventId),
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasGlissando ? styles.active : ''}`}
                  title={`Glissando (Shift+G)${hasGlissando ? ' — open to edit or remove' : ''}`}
                  aria-label="Glissando"
                  aria-pressed={hasGlissando}
                  onClick={() => openFromSubmenu(() => setGlissandoOpen(true))}
                >
                  ╱
                </button>
              )
            })()}
            {(() => {
              // Trill-line button (M20-PR-5). Wavy continuation line
              // extending a trill ornament. Same id-gating.
              if (!editedScore || event.id === undefined) {
                return (
                  <button
                    type="button"
                    className={styles.button}
                    title="Trill line (Shift+Z) — selected event has no id yet"
                    aria-label="Trill line"
                    disabled
                  >
                    tr~
                  </button>
                )
              }
              const spans = editedScore.spans ?? []
              const eventId = event.id
              const hasTrillLine = spans.some(
                (s) =>
                  isTrillLine(s) &&
                  (s.startEventId === eventId || s.endEventId === eventId),
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasTrillLine ? styles.active : ''}`}
                  title={`Trill line (Shift+Z)${hasTrillLine ? ' — open to edit or remove' : ''}`}
                  aria-label="Trill line"
                  aria-pressed={hasTrillLine}
                  onClick={() => openFromSubmenu(() => setTrillLineOpen(true))}
                >
                  tr~
                </button>
              )
            })()}
            {(() => {
              // Tremolo-between button (M20-PR-5). Fingered tremolo
              // between two notes. Distinct from Event.tremolo (single-
              // note repeated tremolo via slashes).
              if (!editedScore || event.id === undefined) {
                return (
                  <button
                    type="button"
                    className={styles.button}
                    title="Tremolo between two notes (Shift+X) — selected event has no id yet"
                    aria-label="Tremolo between two notes"
                    disabled
                  >
                    ≋
                  </button>
                )
              }
              const spans = editedScore.spans ?? []
              const eventId = event.id
              const hasTremoloBetween = spans.some(
                (s) =>
                  isTremoloBetween(s) &&
                  (s.startEventId === eventId || s.endEventId === eventId),
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasTremoloBetween ? styles.active : ''}`}
                  title={`Tremolo between two notes (Shift+X)${hasTremoloBetween ? ' — open to edit or remove' : ''}`}
                  aria-label="Tremolo between two notes"
                  aria-pressed={hasTremoloBetween}
                  onClick={() => openFromSubmenu(() => setTremoloBetweenOpen(true))}
                >
                  ≋
                </button>
              )
            })()}
            {(() => {
              // Tie button (M13-PR-3). Unlike hairpin/slur, ties don't
              // need a remote endpoint id — they apply in-place to the
              // selected event. Disabled on all-rest events (a tie
              // popover for a single rest is functionally useless;
              // setLv / setEnharmonicTie reject on rests and toggleTie
              // on a rest emits no visible tie). The all-rest gate
              // matches the editOperations rest-rejection invariants.
              //
              // active-state highlight reflects EITHER event-wide
              // tied_to_next OR any per-pitch tied_to_next / lv /
              // enharmonicTie flag — all three are persisted state the
              // user might want to revisit, so highlight if any is set.
              const tieActive =
                event.tied_to_next === true ||
                event.pitches.some(
                  (p) =>
                    p.tied_to_next === true ||
                    p.lv === true ||
                    p.enharmonicTie === true,
                )
              const allRests = event.pitches.every((p) => p.step === 'rest')
              if (allRests) {
                return (
                  <button
                    type="button"
                    className={styles.button}
                    title="Tie / lv / enharmonic (Shift+I) — selected event is a rest"
                    aria-label="Tie"
                    disabled
                  >
                    ⌣
                  </button>
                )
              }
              return (
                <button
                  type="button"
                  className={`${styles.button} ${tieActive ? styles.active : ''}`}
                  title={`Tie / lv / enharmonic (Shift+I)${tieActive ? ' — open to edit' : ''}`}
                  aria-label="Tie"
                  aria-pressed={tieActive}
                  onClick={() => openFromSubmenu(() => setTieOpen(true))}
                >
                  ⌣
                </button>
              )
            })()}
          </SubMenu>

          <SubMenu
            open={activeSubmenu === 'structure'}
            label="Structure"
            title="Barlines, voltas, jump markers, delete measure"
            active={(() => {
              if (!editedScore) return false
              const staffIdx = selection.staffIdx ?? 0
              const measure = getStaffMeasureAt(editedScore, staffIdx, selection.measureIdx)
              const hasBarline =
                measure !== undefined &&
                (measure.startBarline !== undefined ||
                  measure.endBarline !== undefined ||
                  measure.isPickup === true ||
                  measure.isFinalPartial === true)
              const hasVolta = (editedScore.voltas ?? []).some(
                (v) =>
                  v.startMeasureIdx <= selection.measureIdx &&
                  selection.measureIdx <= v.endMeasureIdx,
              )
              const hasJump =
                (editedScore.jumpMarkers ?? []).some(
                  (j) => j.measureIdx === selection.measureIdx,
                ) ||
                (editedScore.segnoMarkers ?? []).some(
                  (s) => s.measureIdx === selection.measureIdx,
                ) ||
                (editedScore.codaMarkers ?? []).some(
                  (c) => c.measureIdx === selection.measureIdx,
                )
              return hasBarline || hasVolta || hasJump
            })()}
            ariaLabel="Structure"
            onOpen={() => setActiveSubmenu('structure')}
            onClose={() => setActiveSubmenu(null)}
            estimatedWidth={160}
            estimatedHeight={90}
          >
            {(() => {
              // Barline button (M16-PR-4). Measure-level, so no
              // event-id gating. Active state when the measure
              // containing the selected event carries ANY barline
              // override or anacrusis flag.
              if (!editedScore) return null
              const staffIdx = selection.staffIdx ?? 0
              const measure = getStaffMeasureAt(
                editedScore,
                staffIdx,
                selection.measureIdx,
              )
              if (!measure) return null
              const hasBarline =
                measure.startBarline !== undefined ||
                measure.endBarline !== undefined ||
                measure.isPickup === true ||
                measure.isFinalPartial === true
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasBarline ? styles.active : ''}`}
                  title={`Barlines (Shift+J)${hasBarline ? ' — open to edit or remove' : ''}`}
                  aria-label="Barlines"
                  aria-pressed={hasBarline}
                  onClick={() => openFromSubmenu(openBarlinePopover)}
                >
                  {'||'}
                </button>
              )
            })()}
            {(() => {
              // Volta button (M17-PR-4). Score-level, no event-id
              // gating. Active when any volta touches the selected
              // measure.
              if (!editedScore) return null
              const voltas = editedScore.voltas ?? []
              const hasVoltaHere = voltas.some(
                (v) =>
                  v.startMeasureIdx <= selection.measureIdx &&
                  selection.measureIdx <= v.endMeasureIdx,
              )
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasVoltaHere ? styles.active : ''}`}
                  title={`Voltas (Shift+K)${hasVoltaHere ? ' — open to edit or remove' : ''}`}
                  aria-label="Voltas"
                  aria-pressed={hasVoltaHere}
                  onClick={() => openFromSubmenu(openVoltaPopover)}
                >
                  {'1.'}
                </button>
              )
            })()}
            {(() => {
              // Jump-marker button (M18-PR-5). Score-level; reflects
              // any jumpMarker / segno / coda anchored at the current
              // selected measure. Glyph "D.C." is a common visual cue
              // for the family (D.C./D.S./Fine all live in the same
              // popover).
              if (!editedScore) return null
              const jumps = editedScore.jumpMarkers ?? []
              const segnos = editedScore.segnoMarkers ?? []
              const codas = editedScore.codaMarkers ?? []
              const hasJumpHere =
                jumps.some((j) => j.measureIdx === selection.measureIdx) ||
                segnos.some((s) => s.measureIdx === selection.measureIdx) ||
                codas.some((c) => c.measureIdx === selection.measureIdx)
              return (
                <button
                  type="button"
                  className={`${styles.button} ${hasJumpHere ? styles.active : ''}`}
                  title={`Jump markers (Shift+Y)${hasJumpHere ? ' — open to edit or remove' : ''}`}
                  aria-label="Jump markers"
                  aria-pressed={hasJumpHere}
                  onClick={() => openFromSubmenu(openJumpMarkerPopover)}
                >
                  {'D.C.'}
                </button>
              )
            })()}
            {(() => {
              // Delete-measure button. Opens the always-confirm gate
              // (requestMeasureDelete) rather than mutating directly.
              // Deletes the active measure range if one is set
              // (Cmd/Ctrl+click a bar), else the bar of the selected
              // event. Routes to the span/marker-safe dragMeasureRange
              // delete — never the legacy deleteMeasure op.
              const range =
                measureRangeSelection ?? {
                  fromStart: selection.measureIdx,
                  fromEnd: selection.measureIdx,
                }
              const span = range.fromEnd - range.fromStart + 1
              const title =
                span > 1
                  ? `Delete measures ${range.fromStart + 1}–${range.fromEnd + 1}`
                  : `Delete measure ${range.fromStart + 1}`
              return (
                <button
                  type="button"
                  className={`${styles.button} ${styles.danger}`}
                  title={title}
                  aria-label={span > 1 ? 'Delete measures' : 'Delete measure'}
                  onClick={() => openFromSubmenu(() => requestMeasureDelete(range))}
                >
                  {'🗑'}
                </button>
              )
            })()}
          </SubMenu>
        </>
      )}

      <span className={styles.divider} />

      <button
        type="button"
        className={styles.button}
        title="Insert a quarter-note C after this one, respecting bar lines"
        onClick={() => {
          if (!editedScore) return
          const staffIdx = selection.staffIdx ?? 0
          const voiceIdx = selection.voiceIdx ?? 0
          const seedOctave = staffIdx === 1 ? 3 : 4
          const result = smartInsertNote(
            editedScore,
            { measureIdx: selection.measureIdx, eventIdx: selection.eventIdx },
            { pitches: [{ step: 'C', octave: seedOctave }], duration: 'quarter' },
            staffIdx,
            voiceIdx,
          )
          applyScore(result.score, {
            selection: result.newSelection,
            statusMessage: result.statusMessage,
          })
        }}
      >
        ➕
      </button>

      <button
        type="button"
        className={`${styles.button} ${styles.danger}`}
        title="Delete (Del)"
        onClick={() => applyBalancedEdit({ kind: 'removeBalanced', selection })}
      >
        ⌫
      </button>

      {pitches.length > 0 && pitches[0].step !== 'rest' && (
        <>
          <span className={styles.divider} />
          <div className={styles.chipRow} role="group" aria-label="Chord pitches">
            {pitches.map((p, i) => (
              <span
                key={i}
                className={`${styles.chip} ${i === activePitchIdx ? styles.chipActive : ''}`}
              >
                <button
                  type="button"
                  className={styles.chipLabel}
                  title={`Focus ${pitchLabel(p)}`}
                  onClick={() => select({ ...selection, pitchIdx: i })}
                >
                  {pitchLabel(p)}
                </button>
                {isChord && (
                  <button
                    type="button"
                    className={styles.chipRemove}
                    title={`Remove ${pitchLabel(p)}`}
                    aria-label={`Remove ${pitchLabel(p)}`}
                    onClick={() =>
                      applyEdit({ kind: 'removePitchFromChord', target: selection, pitchIdx: i })
                    }
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
          {canStack && (
            <>
              <span className={styles.divider} />
              <div className={styles.group}>
                <button
                  type="button"
                  className={styles.button}
                  title="Stack a diatonic 3rd above the top pitch"
                  onClick={() => stackAbove(3)}
                >
                  +3
                </button>
                <button
                  type="button"
                  className={styles.button}
                  title="Stack a diatonic 5th above the top pitch"
                  onClick={() => stackAbove(5)}
                >
                  +5
                </button>
                <button
                  type="button"
                  className={styles.button}
                  title="Stack a diatonic 7th above the top pitch"
                  onClick={() => stackAbove(7)}
                >
                  +7
                </button>
              </div>
            </>
          )}
          <span className={styles.divider} />
          <button
            type="button"
            className={styles.button}
            title="Replace with a common chord rooted here"
            onClick={() => setConvertOpen(true)}
          >
            Chord…
          </button>
        </>
      )}

      {editedScore && (
        <ChordPalette
          open={convertOpen}
          anchorX={selection.anchorX ?? window.innerWidth / 2}
          anchorY={selection.anchorY ?? 120}
          initialRoot={pitches[activePitchIdx]}
          scoreKey={editedScore.key}
          submitLabel="Replace"
          onClose={() => setConvertOpen(false)}
          onSubmit={(nextPitches) => {
            applyEdit({ kind: 'setEventPitches', target: selection, pitches: nextPitches })
          }}
        />
      )}

      {event && (
        <DynamicsPopover
          open={dynamicsOpen}
          anchorX={selection.anchorX ?? window.innerWidth / 2}
          anchorY={selection.anchorY ?? 120}
          initialText={(() => {
            const current = getDynamicMarking(event)
            return current ? formatDynamic(current) : ''
          })()}
          onClose={() => setDynamicsOpen(false)}
          onSubmit={(marking) => {
            // Compound (has prefix or suffix) → dynamic_structured op.
            // Simple base-only → setDynamic; this also strips a stale
            // dynamic_structured automatically (see editOperations.ts
            // setDynamic case).
            if (marking.prefix !== undefined || marking.suffix !== undefined) {
              applyEdit({
                kind: 'setDynamicStructured',
                target: selection,
                dynamic_structured: marking,
              })
            } else {
              applyEdit({ kind: 'setDynamic', target: selection, dynamic: marking.base })
            }
          }}
        />
      )}

      {event && (
        <OrnamentMenuPopover
          open={ornamentMenuOpen}
          anchorX={selection.anchorX ?? window.innerWidth / 2}
          anchorY={selection.anchorY ?? 120}
          current={event}
          onClose={() => setOrnamentMenuOpen(false)}
          onPatch={(patch: OrnamentMenuPatch) => {
            // Each patch translates to one op (M2-PR-3 setOrnament /
            // setTremolo / setJazzInflection or M6 setTrillUpperPitch)
            // against the current selection. Routed at the call site
            // so the popover stays decoupled from the chat-store
            // selection.
            //
            // The auto-clear of orphan trillUpperPitch when an
            // ornament leaves the trill family is dispatched HERE
            // (not in the popover) so it can re-read the live event
            // from the store. The popover's `current` prop would be
            // closure-stale across a rapid double-click — same
            // pattern M3-PR-4 / M5-PR-3 hit and fixed.
            if (patch.kind === 'ornament') {
              applyEdit({ kind: 'setOrnament', target: selection, ornament: patch.ornament })
              if (!isTrillFamilyOrnament(patch.ornament)) {
                const liveScore = useChatStore.getState().editedScore
                const liveEvent = liveScore
                  ? getStaffEventAt(
                      liveScore,
                      selection.staffIdx ?? 0,
                      selection.measureIdx,
                      selection.eventIdx,
                    )
                  : undefined
                if (liveEvent?.trillUpperPitch !== undefined) {
                  applyEdit({ kind: 'setTrillUpperPitch', target: selection })
                }
              }
            } else if (patch.kind === 'trillUpperPitch') {
              applyEdit(
                patch.trillUpperPitch === undefined
                  ? { kind: 'setTrillUpperPitch', target: selection }
                  : {
                      kind: 'setTrillUpperPitch',
                      target: selection,
                      trillUpperPitch: patch.trillUpperPitch,
                    },
              )
            } else if (patch.kind === 'tremolo') {
              applyEdit(
                patch.tremolo === undefined
                  ? { kind: 'setTremolo', target: selection }
                  : { kind: 'setTremolo', target: selection, tremolo: patch.tremolo },
              )
            } else {
              applyEdit(
                patch.jazzInflection === undefined
                  ? { kind: 'setJazzInflection', target: selection }
                  : {
                      kind: 'setJazzInflection',
                      target: selection,
                      jazzInflection: patch.jazzInflection,
                    },
              )
            }
          }}
        />
      )}

      {event && editedScore && (
        <TechniquePopover
          open={techniqueOpen}
          anchorX={selection.anchorX ?? window.innerWidth / 2}
          anchorY={selection.anchorY ?? 120}
          markersAtPosition={techniquesAtPosition(
            editedScore,
            selection.staffIdx ?? 0,
            selection.voiceIdx ?? 0,
            selection.measureIdx,
            selection.eventIdx,
          )}
          activeTechnique={activeTechniqueAt(
            editedScore,
            selection.staffIdx ?? 0,
            selection.voiceIdx ?? 0,
            selection.measureIdx,
            selection.eventIdx,
          )}
          onClose={() => setTechniqueOpen(false)}
          onPatch={(patch: TechniquePopoverPatch) => {
            // Re-read live state at click time. Fast double-clicks
            // would otherwise see stale `markersAtPosition` from the
            // render closure: two clicks on the same button both fire
            // before React re-renders the popover, producing duplicate
            // markers (insert path) or "id not found" (remove path).
            // Same closure-staleness fix M2-PR-5a applied to
            // articulations.
            const liveScore = useChatStore.getState().editedScore
            if (!liveScore) return
            const liveMarkers = techniquesAtPosition(
              liveScore,
              selection.staffIdx ?? 0,
              selection.voiceIdx ?? 0,
              selection.measureIdx,
              selection.eventIdx,
            )
            const existing = liveMarkers.find((m) => m.kind === patch.technique)
            if (existing && existing.id !== undefined) {
              applyEdit({ kind: 'removeTechniqueChange', id: existing.id })
            } else {
              applyEdit({
                kind: 'insertTechniqueChange',
                techniqueChange: {
                  measureIdx: selection.measureIdx,
                  eventIdx: selection.eventIdx,
                  staffIdx: selection.staffIdx ?? 0,
                  voiceIdx: selection.voiceIdx ?? 0,
                  kind: patch.technique,
                },
              })
            }
          }}
        />
      )}

      {event && (() => {
        // Compute seed text + clear handler against the LIVE store on
        // every render so closure-staleness can't yield a stale "current
        // fingering" view. Same pattern M3-PR-4 / M2-PR-5a established.
        const focusedPitchIdx = selection.pitchIdx ?? 0
        const focusedPitch = event.pitches[focusedPitchIdx]
        if (!focusedPitch || focusedPitch.step === 'rest') return null
        const current = getFingering(event, focusedPitchIdx)
        const initialText = current ? formatFingering(current) : ''
        const clearTarget = { ...selection, pitchIdx: focusedPitchIdx }
        return (
          <FingeringPopover
            open={fingeringOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            initialText={initialText}
            {...(current
              ? { onClear: () => applyEdit({ kind: 'removeFingering', target: clearTarget }) }
              : {})}
            onClose={() => setFingeringOpen(false)}
            onSubmit={(fingering) => {
              // Re-read selection at submit time so the op targets the
              // pitchIdx that was focused when the user hit Apply, not
              // a stale render-closure copy.
              const liveSelection = useChatStore.getState().selection
              if (!liveSelection) return
              applyEdit({
                kind: 'setFingering',
                target: { ...liveSelection, pitchIdx: liveSelection.pitchIdx ?? 0 },
                fingering,
              })
            }}
          />
        )
      })()}

      {event && (() => {
        // Seed text + clear handler computed on every render against
        // the live store, same closure-staleness fix the fingerings
        // popover uses. graceNotes attach to the whole event (not
        // per-pitch) so there's no pitchIdx step here.
        if (event.pitches[0]?.step === 'rest') return null
        const currentGraces = event.graceNotes
        const hasGraces = (currentGraces?.length ?? 0) > 0
        const initialText = hasGraces ? formatGraceNotes(currentGraces!) : ''
        return (
          <GraceNotePopover
            open={graceNoteOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            initialText={initialText}
            {...(hasGraces
              ? { onClear: () => applyEdit({ kind: 'setGraceNotes', target: selection, graceNotes: [] }) }
              : {})}
            onClose={() => setGraceNoteOpen(false)}
            onSubmit={(graceNotes) => {
              // Re-read selection at submit so a target change between
              // popover open and Apply (chip switch, click) doesn't
              // land the grace on the wrong event.
              const liveSelection = useChatStore.getState().selection
              if (!liveSelection) return
              applyEdit({ kind: 'setGraceNotes', target: liveSelection, graceNotes })
            }}
          />
        )
      })()}

      {editedScore && (() => {
        // Annotations popover (M8-PR-4). existingAnnotations is filtered
        // here against the LIVE store on every render so closure-stale
        // lists can't yield "remove id not found" errors on rapid
        // double-clicks — same pattern M3-PR-4 / M5-PR-3 established.
        //
        // Measure-level annotations (no target.eventIdx) collapse to
        // eventIdx 0 via the `?? 0` fallback — the M8-PR-3 renderer
        // anchors them there too, so a rehearsal mark on the bar's
        // first event is indistinguishable from one on the measure.
        // Selecting eventIdx 0 shows measure-level annotations; later
        // events in the same bar don't (consistent with how they're
        // visually placed).
        const liveAnnotations = (editedScore.annotations ?? []).filter(
          (a) =>
            a.target.measureIdx === selection.measureIdx &&
            (a.target.eventIdx ?? 0) === selection.eventIdx,
        )
        return (
          <AnnotationPopover
            open={annotationOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingAnnotations={liveAnnotations}
            onClose={() => setAnnotationOpen(false)}
            onPatch={(patch: AnnotationPopoverPatch) => {
              if (patch.kind === 'insert') {
                const liveSelection = useChatStore.getState().selection
                if (!liveSelection) return
                applyEdit({
                  kind: 'insertAnnotation',
                  annotation: {
                    measureIdx: liveSelection.measureIdx,
                    eventIdx: liveSelection.eventIdx,
                    position: patch.position,
                    text: patch.text,
                    style: patch.style,
                  },
                })
              } else {
                // Remove by id — id resolution is closure-safe because
                // ids are stable across re-renders (M8-PR-1 mints them
                // server-side and ensureAnnotationIds backfills LLM
                // emissions).
                applyEdit({ kind: 'removeAnnotation', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && markerOpen && markerTarget && (() => {
        // Marker popover (M9-PR-4, snapshot-target alignment M19-PR-1
        // review). Markers attach to MEASURE boundaries (no eventIdx),
        // so the filter only checks measureIdx. Same snapshot-target-
        // on-open pattern as BarlinePopover / VoltaPopover /
        // JumpMarkerPopover — the existing-list and the dispatch both
        // anchor on the measureIdx captured at open. Mid-popover
        // selection changes don't redirect the popover or split the
        // displayed list from the patched target.
        const target = markerTarget
        const liveMarkers = (editedScore.markers ?? []).filter(
          (m) => m.measureIdx === target.measureIdx,
        )
        return (
          <MarkerPopover
            open={markerOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingMarkers={liveMarkers}
            staffCount={editedScore.secondStaff !== undefined ? 2 : 1}
            onClose={() => {
              setMarkerOpen(false)
              setMarkerTarget(null)
            }}
            onPatch={(patch: MarkerPopoverPatch) => {
              if (patch.kind === 'insert') {
                applyEdit({
                  kind: 'insertMarker',
                  marker: {
                    measureIdx: target.measureIdx,
                    ...(patch.key !== undefined ? { key: patch.key } : {}),
                    ...(patch.meter !== undefined ? { meter: patch.meter } : {}),
                    ...(patch.tempo_bpm !== undefined ? { tempo_bpm: patch.tempo_bpm } : {}),
                    ...(patch.tempo_text !== undefined ? { tempo_text: patch.tempo_text } : {}),
                    ...(patch.clefs !== undefined ? { clefs: patch.clefs } : {}),
                    ...(patch.metricModulation !== undefined
                      ? { metricModulation: patch.metricModulation }
                      : {}),
                  },
                })
              } else {
                // Remove by id — closure-safe because ids are stable
                // (M9-PR-1 mints them server-side and ensureMarkerIds
                // backfills LLM emissions).
                applyEdit({ kind: 'removeMarker', id: patch.id })
              }
            }}
          />
        )
      })()}

      {event && (() => {
        // Chord symbol popover (M10-PR-5). Per-event chord symbol —
        // selection.measureIdx + selection.eventIdx address it. The
        // seed text is the canonical formatted form of the current
        // chord (so a user editing Cmaj7 sees "Cmaj7" pre-filled,
        // not the raw display string they originally typed).
        const currentChord = event.chordSymbol
        const initialText = currentChord ? formatChordSymbol(currentChord) : ''
        return (
          <ChordSymbolPopover
            open={chordSymbolOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            initialText={initialText}
            {...(currentChord
              ? { onClear: () => applyEdit({ kind: 'setChordSymbol', target: selection }) }
              : {})}
            onClose={() => setChordSymbolOpen(false)}
            onSubmit={(chord) => {
              // Re-read selection at submit so a target change
              // between popover open and Apply doesn't land the
              // chord on the wrong event.
              const liveSelection = useChatStore.getState().selection
              if (!liveSelection) return
              applyEdit({
                kind: 'setChordSymbol',
                target: liveSelection,
                chordSymbol: chord,
              })
            }}
          />
        )
      })()}

      {editedScore && event && event.id !== undefined && hairpinOpen && (() => {
        // Hairpin popover (M11-PR-5). The selected note is the START
        // of the hairpin; the user picks an end-event from the
        // dropdown. Existing-hairpins list shows wedges already on
        // this voice (id-bearing only — un-id'd entries can't be
        // removed, so showing them as ghost rows is worse than
        // hiding). Gated on hairpinOpen so the per-render walk
        // doesn't fire when the popover is closed.
        const staffIdx = selection.staffIdx ?? 0
        const voiceIdx = selection.voiceIdx ?? 0
        const spans = editedScore.spans ?? []
        const existingHairpins = spans.filter(
          (s): s is Span & { kind: HairpinKind } =>
            isHairpin(s) && s.staffIdx === staffIdx && s.voiceIdx === voiceIdx && s.id !== undefined,
        )
        // Available end events = subsequent events on the same voice,
        // including the current event (zero-duration wedge is valid).
        // Cap to 240 entries (~one full staff page at 4/4) so long
        // pieces don't produce 1000-entry dropdowns but most natural
        // hairpin lengths fit comfortably.
        const availableEnds = buildAvailableEnds(editedScore, staffIdx, voiceIdx, selection.measureIdx, selection.eventIdx, 240)
        // Positions map for the existing-hairpins summary — built from
        // the WHOLE voice (not just availableEnds) so a hairpin
        // earlier in the score still shows its start→end positions
        // in the chip text. Cheap walk: same voice as availableEnds.
        const eventPositions = buildEventPositions(editedScore, staffIdx, voiceIdx)
        return (
          <HairpinPopover
            open={hairpinOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingHairpins={existingHairpins}
            availableEnds={availableEnds}
            eventPositions={eventPositions}
            onClose={() => setHairpinOpen(false)}
            onPatch={(patch: HairpinPopoverPatch) => {
              if (patch.kind === 'insert') {
                // Re-read selection at submit so a target change
                // between popover open and Apply doesn't land the
                // hairpin on a different start event.
                const liveSelection = useChatStore.getState().selection
                const liveScore = useChatStore.getState().editedScore
                if (!liveSelection || !liveScore) return
                const startEvent = getStaffEventAt(
                  liveScore,
                  liveSelection.staffIdx ?? 0,
                  liveSelection.measureIdx,
                  liveSelection.eventIdx,
                )
                if (!startEvent?.id) return
                applyEdit({
                  kind: 'insertHairpin',
                  hairpin: {
                    kind: patch.hairpinKind,
                    startEventId: startEvent.id,
                    endEventId: patch.endEventId,
                    staffIdx: liveSelection.staffIdx ?? 0,
                    voiceIdx: liveSelection.voiceIdx ?? 0,
                    ...(patch.startDynamic !== undefined ? { startDynamic: patch.startDynamic } : {}),
                    ...(patch.endDynamic !== undefined ? { endDynamic: patch.endDynamic } : {}),
                    ...(patch.placement !== undefined ? { placement: patch.placement } : {}),
                  },
                })
              } else {
                applyEdit({ kind: 'removeHairpin', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && event && event.id !== undefined && slurOpen && (() => {
        // Slur popover (M12-PR-4). Same pattern as the hairpin popover:
        // the selected note is the START of the slur; the user picks
        // an end-event from the dropdown. Existing-slurs list shows
        // id-bearing slurs on this voice.
        const staffIdx = selection.staffIdx ?? 0
        const voiceIdx = selection.voiceIdx ?? 0
        const spans = editedScore.spans ?? []
        const existingSlurs = spans.filter(
          (s): s is Span & { kind: SlurKind } =>
            isSlur(s) && s.staffIdx === staffIdx && s.voiceIdx === voiceIdx && s.id !== undefined,
        )
        const availableEnds = buildAvailableEnds(editedScore, staffIdx, voiceIdx, selection.measureIdx, selection.eventIdx, 240)
        const eventPositions = buildEventPositions(editedScore, staffIdx, voiceIdx)
        return (
          <SlurPopover
            open={slurOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingSlurs={existingSlurs}
            availableEnds={availableEnds}
            eventPositions={eventPositions}
            onClose={() => setSlurOpen(false)}
            onPatch={(patch: SlurPopoverPatch) => {
              if (patch.kind === 'insert') {
                const liveSelection = useChatStore.getState().selection
                const liveScore = useChatStore.getState().editedScore
                if (!liveSelection || !liveScore) return
                const startEvent = getStaffEventAt(
                  liveScore,
                  liveSelection.staffIdx ?? 0,
                  liveSelection.measureIdx,
                  liveSelection.eventIdx,
                )
                if (!startEvent?.id) return
                applyEdit({
                  kind: 'insertSlur',
                  slur: {
                    kind: patch.slurKind,
                    startEventId: startEvent.id,
                    endEventId: patch.endEventId,
                    staffIdx: liveSelection.staffIdx ?? 0,
                    voiceIdx: liveSelection.voiceIdx ?? 0,
                    ...(patch.placement !== undefined ? { placement: patch.placement } : {}),
                  },
                })
              } else {
                applyEdit({ kind: 'removeSlur', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && event && tieOpen && (() => {
        // Tie popover (M13-PR-3). Edits per-pitch tied_to_next, lv,
        // and enharmonicTie flags PLUS the event-wide tied_to_next
        // master toggle. Unlike hairpin/slur this doesn't need an
        // endpoint id — the tie applies in-place. Patches are
        // user-intent (event-wide vs per-pitch vs lv vs enharmonic);
        // the caller resolves against the LIVE store at submit time
        // so a mid-popover selection change doesn't corrupt the score.
        return (
          <TiePopover
            open={tieOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            pitches={event.pitches}
            eventTiedToNext={event.tied_to_next === true}
            onClose={() => setTieOpen(false)}
            onPatch={(patch: TiePopoverPatch) => {
              const liveSelection = useChatStore.getState().selection
              const liveScore = useChatStore.getState().editedScore
              if (!liveSelection || !liveScore) return
              const liveEvent = getStaffEventAt(
                liveScore,
                liveSelection.staffIdx ?? 0,
                liveSelection.measureIdx,
                liveSelection.eventIdx,
              )
              if (!liveEvent) return
              const target = {
                staffIdx: liveSelection.staffIdx,
                voiceIdx: liveSelection.voiceIdx,
                measureIdx: liveSelection.measureIdx,
                eventIdx: liveSelection.eventIdx,
              }
              if (patch.kind === 'event') {
                // toggleTie flips current → desired. Only dispatch
                // when the live event's current value differs — saves
                // a no-op op + undo entry.
                if ((liveEvent.tied_to_next === true) !== patch.tied_to_next) {
                  applyEdit({ kind: 'toggleTie', target })
                }
              } else if (patch.kind === 'pitch-tie') {
                // Persist explicit false too — it's the documented
                // override for releasing one chord tone from an
                // event-wide tied_to_next:true (per pitchTies.ts:24-26
                // precedence). Stripping would silently fall back to
                // the event-wide flag and re-tie the pitch.
                applyEdit({
                  kind: 'setPitchTie',
                  target: { ...target, pitchIdx: patch.pitchIdx },
                  tied_to_next: patch.tied_to_next,
                })
              } else if (patch.kind === 'lv') {
                applyEdit({
                  kind: 'setLv',
                  target: { ...target, pitchIdx: patch.pitchIdx },
                  lv: patch.lv,
                })
              } else if (patch.kind === 'enharmonic') {
                applyEdit({
                  kind: 'setEnharmonicTie',
                  target: { ...target, pitchIdx: patch.pitchIdx },
                  enharmonicTie: patch.enharmonicTie,
                })
              }
            }}
          />
        )
      })()}

      {editedScore && event && event.id !== undefined && tempoSpanOpen && (() => {
        // Tempo-span popover (M14-PR-3). Same pattern as the hairpin
        // and slur popovers: the selected note is the START of the
        // tempo span; the user picks an end-event from the dropdown.
        // Existing-spans list shows id-bearing tempo spans on this
        // voice.
        const staffIdx = selection.staffIdx ?? 0
        const voiceIdx = selection.voiceIdx ?? 0
        const spans = editedScore.spans ?? []
        const existingTempoSpans = spans.filter(
          (s): s is Span & { kind: TempoSpanKind } =>
            isTempoSpan(s) &&
            s.staffIdx === staffIdx &&
            s.voiceIdx === voiceIdx &&
            s.id !== undefined,
        )
        const availableEnds = buildAvailableEnds(
          editedScore,
          staffIdx,
          voiceIdx,
          selection.measureIdx,
          selection.eventIdx,
          240,
        )
        const eventPositions = buildEventPositions(editedScore, staffIdx, voiceIdx)
        return (
          <TempoSpanPopover
            open={tempoSpanOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingTempoSpans={existingTempoSpans}
            availableEnds={availableEnds}
            eventPositions={eventPositions}
            onClose={() => setTempoSpanOpen(false)}
            onPatch={(patch: TempoSpanPopoverPatch) => {
              if (patch.kind === 'insert') {
                const liveSelection = useChatStore.getState().selection
                const liveScore = useChatStore.getState().editedScore
                if (!liveSelection || !liveScore) return
                const startEvent = getStaffEventAt(
                  liveScore,
                  liveSelection.staffIdx ?? 0,
                  liveSelection.measureIdx,
                  liveSelection.eventIdx,
                )
                if (!startEvent?.id) return
                applyEdit({
                  kind: 'insertTempoSpan',
                  tempoSpan: {
                    kind: patch.tempoKind,
                    startEventId: startEvent.id,
                    endEventId: patch.endEventId,
                    staffIdx: liveSelection.staffIdx ?? 0,
                    voiceIdx: liveSelection.voiceIdx ?? 0,
                    ...(patch.placement !== undefined
                      ? { placement: patch.placement }
                      : {}),
                    ...(patch.endTempoBpm !== undefined
                      ? { endTempoBpm: patch.endTempoBpm }
                      : {}),
                    ...(patch.endTempoText !== undefined
                      ? { endTempoText: patch.endTempoText }
                      : {}),
                  },
                })
              } else {
                applyEdit({ kind: 'removeTempoSpan', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && event && event.id !== undefined && octaveSpanOpen && (() => {
        // Octave-span popover (M20-PR-4). Same pattern as
        // TempoSpanPopover: the selected note is the START of the
        // octave span; the user picks an end-event from the dropdown.
        const staffIdx = selection.staffIdx ?? 0
        const voiceIdx = selection.voiceIdx ?? 0
        const spans = editedScore.spans ?? []
        const existingOctaveSpans = spans.filter(
          (s): s is Span & { kind: OctaveSpanKind } =>
            isOctaveSpan(s) &&
            s.staffIdx === staffIdx &&
            s.voiceIdx === voiceIdx &&
            s.id !== undefined,
        )
        const availableEnds = buildAvailableEnds(
          editedScore,
          staffIdx,
          voiceIdx,
          selection.measureIdx,
          selection.eventIdx,
          240,
        )
        const eventPositions = buildEventPositions(editedScore, staffIdx, voiceIdx)
        return (
          <OctaveSpanPopover
            open={octaveSpanOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingOctaveSpans={existingOctaveSpans}
            availableEnds={availableEnds}
            eventPositions={eventPositions}
            onClose={() => setOctaveSpanOpen(false)}
            onPatch={(patch: OctaveSpanPopoverPatch) => {
              if (patch.kind === 'insert') {
                const liveSelection = useChatStore.getState().selection
                const liveScore = useChatStore.getState().editedScore
                if (!liveSelection || !liveScore) return
                const startEvent = getStaffEventAt(
                  liveScore,
                  liveSelection.staffIdx ?? 0,
                  liveSelection.measureIdx,
                  liveSelection.eventIdx,
                )
                if (!startEvent?.id) return
                applyEdit({
                  kind: 'insertOctaveSpan',
                  octaveSpan: {
                    kind: patch.octaveKind,
                    startEventId: startEvent.id,
                    endEventId: patch.endEventId,
                    staffIdx: liveSelection.staffIdx ?? 0,
                    voiceIdx: liveSelection.voiceIdx ?? 0,
                    ...(patch.placement !== undefined
                      ? { placement: patch.placement }
                      : {}),
                  },
                })
              } else {
                applyEdit({ kind: 'removeOctaveSpan', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && event && event.id !== undefined && glissandoOpen && (() => {
        // Glissando popover (M20-PR-4). Single-kind family; same
        // address-by-event-id model as the other span popovers.
        const staffIdx = selection.staffIdx ?? 0
        const voiceIdx = selection.voiceIdx ?? 0
        const spans = editedScore.spans ?? []
        const existingGlissandos = spans.filter(
          (s): s is Span & { kind: 'glissando' } =>
            isGlissando(s) &&
            s.staffIdx === staffIdx &&
            s.voiceIdx === voiceIdx &&
            s.id !== undefined,
        )
        const availableEnds = buildAvailableEnds(
          editedScore,
          staffIdx,
          voiceIdx,
          selection.measureIdx,
          selection.eventIdx,
          240,
        )
        const eventPositions = buildEventPositions(editedScore, staffIdx, voiceIdx)
        return (
          <GlissandoPopover
            open={glissandoOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingGlissandos={existingGlissandos}
            availableEnds={availableEnds}
            eventPositions={eventPositions}
            onClose={() => setGlissandoOpen(false)}
            onPatch={(patch: GlissandoPopoverPatch) => {
              if (patch.kind === 'insert') {
                const liveSelection = useChatStore.getState().selection
                const liveScore = useChatStore.getState().editedScore
                if (!liveSelection || !liveScore) return
                const startEvent = getStaffEventAt(
                  liveScore,
                  liveSelection.staffIdx ?? 0,
                  liveSelection.measureIdx,
                  liveSelection.eventIdx,
                )
                if (!startEvent?.id) return
                applyEdit({
                  kind: 'insertGlissando',
                  glissando: {
                    startEventId: startEvent.id,
                    endEventId: patch.endEventId,
                    staffIdx: liveSelection.staffIdx ?? 0,
                    voiceIdx: liveSelection.voiceIdx ?? 0,
                    ...(patch.placement !== undefined
                      ? { placement: patch.placement }
                      : {}),
                    ...(patch.glissStyle !== undefined
                      ? { glissStyle: patch.glissStyle }
                      : {}),
                    ...(patch.glissText !== undefined
                      ? { glissText: patch.glissText }
                      : {}),
                  },
                })
              } else {
                applyEdit({ kind: 'removeGlissando', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && event && event.id !== undefined && trillLineOpen && (() => {
        // Trill-line popover (M20-PR-5). Single-kind family; same
        // address-by-event-id model.
        const staffIdx = selection.staffIdx ?? 0
        const voiceIdx = selection.voiceIdx ?? 0
        const spans = editedScore.spans ?? []
        const existingTrillLines = spans.filter(
          (s): s is Span & { kind: 'trill-line' } =>
            isTrillLine(s) &&
            s.staffIdx === staffIdx &&
            s.voiceIdx === voiceIdx &&
            s.id !== undefined,
        )
        const availableEnds = buildAvailableEnds(
          editedScore,
          staffIdx,
          voiceIdx,
          selection.measureIdx,
          selection.eventIdx,
          240,
        )
        const eventPositions = buildEventPositions(editedScore, staffIdx, voiceIdx)
        return (
          <TrillLinePopover
            open={trillLineOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingTrillLines={existingTrillLines}
            availableEnds={availableEnds}
            eventPositions={eventPositions}
            onClose={() => setTrillLineOpen(false)}
            onPatch={(patch: TrillLinePopoverPatch) => {
              if (patch.kind === 'insert') {
                const liveSelection = useChatStore.getState().selection
                const liveScore = useChatStore.getState().editedScore
                if (!liveSelection || !liveScore) return
                const startEvent = getStaffEventAt(
                  liveScore,
                  liveSelection.staffIdx ?? 0,
                  liveSelection.measureIdx,
                  liveSelection.eventIdx,
                )
                if (!startEvent?.id) return
                applyEdit({
                  kind: 'insertTrillLine',
                  trillLine: {
                    startEventId: startEvent.id,
                    endEventId: patch.endEventId,
                    staffIdx: liveSelection.staffIdx ?? 0,
                    voiceIdx: liveSelection.voiceIdx ?? 0,
                    ...(patch.placement !== undefined
                      ? { placement: patch.placement }
                      : {}),
                  },
                })
              } else {
                applyEdit({ kind: 'removeTrillLine', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && event && event.id !== undefined && tremoloBetweenOpen && (() => {
        // Tremolo-between popover (M20-PR-5). Single-kind family.
        const staffIdx = selection.staffIdx ?? 0
        const voiceIdx = selection.voiceIdx ?? 0
        const spans = editedScore.spans ?? []
        const existingTremolos = spans.filter(
          (s): s is Span & { kind: 'tremolo-between' } =>
            isTremoloBetween(s) &&
            s.staffIdx === staffIdx &&
            s.voiceIdx === voiceIdx &&
            s.id !== undefined,
        )
        const availableEnds = buildAvailableEnds(
          editedScore,
          staffIdx,
          voiceIdx,
          selection.measureIdx,
          selection.eventIdx,
          240,
        )
        const eventPositions = buildEventPositions(editedScore, staffIdx, voiceIdx)
        return (
          <TremoloBetweenPopover
            open={tremoloBetweenOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingTremolos={existingTremolos}
            availableEnds={availableEnds}
            eventPositions={eventPositions}
            onClose={() => setTremoloBetweenOpen(false)}
            onPatch={(patch: TremoloBetweenPopoverPatch) => {
              if (patch.kind === 'insert') {
                const liveSelection = useChatStore.getState().selection
                const liveScore = useChatStore.getState().editedScore
                if (!liveSelection || !liveScore) return
                const startEvent = getStaffEventAt(
                  liveScore,
                  liveSelection.staffIdx ?? 0,
                  liveSelection.measureIdx,
                  liveSelection.eventIdx,
                )
                if (!startEvent?.id) return
                applyEdit({
                  kind: 'insertTremoloBetween',
                  tremoloBetween: {
                    startEventId: startEvent.id,
                    endEventId: patch.endEventId,
                    staffIdx: liveSelection.staffIdx ?? 0,
                    voiceIdx: liveSelection.voiceIdx ?? 0,
                    ...(patch.placement !== undefined
                      ? { placement: patch.placement }
                      : {}),
                  },
                })
              } else {
                applyEdit({ kind: 'removeTremoloBetween', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && event && lyricsOpen && (() => {
        // Lyrics popover (M15-PR-4). Per-event, per-verse syllable
        // entry. No endpoint id required — lyrics are flat per-event
        // properties. Closure-staleness defense: re-read
        // useChatStore.getState() at submit time so a mid-popover
        // selection change doesn't corrupt the patch.
        const isRest = event.pitches.every((p) => p.step === 'rest')
        return (
          <LyricsPopover
            open={lyricsOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            existingLyrics={event.lyrics ?? []}
            isRest={isRest}
            onClose={() => setLyricsOpen(false)}
            onPatch={(patch: LyricsPopoverPatch) => {
              const liveSelection = useChatStore.getState().selection
              const liveScore = useChatStore.getState().editedScore
              if (!liveSelection || !liveScore) return
              const target = {
                staffIdx: liveSelection.staffIdx,
                voiceIdx: liveSelection.voiceIdx,
                measureIdx: liveSelection.measureIdx,
                eventIdx: liveSelection.eventIdx,
              }
              if (patch.kind === 'set') {
                applyEdit({
                  kind: 'setLyric',
                  target,
                  verse: patch.verse,
                  syllable: patch.syllable,
                  ...(patch.hyphen ? { hyphen: true } : {}),
                  ...(patch.extender ? { extender: true } : {}),
                })
              } else if (patch.kind === 'remove') {
                applyEdit({
                  kind: 'removeLyric',
                  target,
                  verse: patch.verse,
                })
              } else if (patch.kind === 'clear') {
                applyEdit({ kind: 'clearLyrics', target })
              }
            }}
          />
        )
      })()}

      {editedScore && barlineOpen && barlineTarget && (() => {
        // Barline popover (M16-PR-4). Measure-level; no event-id
        // gate. The TARGET measure is snapshotted into
        // barlineTarget state at open time — mid-popover selection
        // changes do NOT redirect the popover to a new measure
        // (M16-PR-4 review fix). The dispatcher reads from the
        // snapshot, not from useChatStore.getState(), so the patch
        // always targets the measure the user explicitly opened
        // the popover on. Live measure data (startBarline /
        // endBarline / isPickup) is still read fresh on every
        // render so the popover reflects updates from concurrent
        // edits or the user's own dispatched patches.
        const target = barlineTarget
        const measure = getStaffMeasureAt(editedScore, target.staffIdx, target.measureIdx)
        if (!measure) return null
        return (
          <BarlinePopover
            open={barlineOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            measureIdx={target.measureIdx}
            startBarline={measure.startBarline}
            endBarline={measure.endBarline}
            isPickup={measure.isPickup === true}
            isFinalPartial={measure.isFinalPartial === true}
            onClose={() => setBarlineOpen(false)}
            onPatch={(patch: BarlinePopoverPatch) => {
              // Dispatch against the SNAPSHOTTED target, NOT live
              // selection — the popover is scoped to one measure
              // for its entire lifetime.
              if (patch.kind === 'start') {
                applyEdit({
                  kind: 'setStartBarline',
                  staffIdx: target.staffIdx,
                  measureIdx: target.measureIdx,
                  ...(patch.barline !== null ? { barline: patch.barline } : {}),
                })
              } else if (patch.kind === 'end') {
                applyEdit({
                  kind: 'setEndBarline',
                  staffIdx: target.staffIdx,
                  measureIdx: target.measureIdx,
                  ...(patch.barline !== null ? { barline: patch.barline } : {}),
                })
              } else if (patch.kind === 'pickup') {
                applyEdit({
                  kind: 'setPickup',
                  staffIdx: target.staffIdx,
                  measureIdx: target.measureIdx,
                  isPickup: patch.isPickup,
                })
              } else if (patch.kind === 'finalPartial') {
                applyEdit({
                  kind: 'setFinalPartial',
                  staffIdx: target.staffIdx,
                  measureIdx: target.measureIdx,
                  isFinalPartial: patch.isFinalPartial,
                })
              }
            }}
          />
        )
      })()}

      {editedScore && voltaOpen && voltaTarget && (() => {
        // Volta popover (M17-PR-4). Score-level; no event-id gate.
        // Same snapshot pattern as BarlinePopover — the target
        // measure is captured at open time so mid-popover selection
        // changes don't redirect the popover.
        const target = voltaTarget
        return (
          <VoltaPopover
            open={voltaOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            measureIdx={target.measureIdx}
            existingVoltas={editedScore.voltas ?? []}
            measureCount={editedScore.measures.length}
            onClose={() => {
              setVoltaOpen(false)
              setVoltaTarget(null)
            }}
            onPatch={(patch: VoltaPopoverPatch) => {
              if (patch.kind === 'insert') {
                const volta: {
                  startMeasureIdx: number
                  endMeasureIdx: number
                  endings: number[]
                  endHook?: 'closed' | 'open'
                  text?: string
                } = {
                  startMeasureIdx: patch.startMeasureIdx,
                  endMeasureIdx: patch.endMeasureIdx,
                  endings: patch.endings,
                }
                if (patch.endHook !== undefined) volta.endHook = patch.endHook
                if (patch.text !== undefined) volta.text = patch.text
                applyEdit({ kind: 'insertVolta', volta })
              } else {
                applyEdit({ kind: 'removeVolta', id: patch.id })
              }
            }}
          />
        )
      })()}

      {editedScore && jumpMarkerOpen && jumpMarkerTarget && (() => {
        // JumpMarker popover (M18-PR-5). Score-level; no event-id
        // gate. Same snapshot pattern as VoltaPopover — the target
        // measure is captured at open time so mid-popover selection
        // changes don't redirect the popover.
        const target = jumpMarkerTarget
        return (
          <JumpMarkerPopover
            open={jumpMarkerOpen}
            anchorX={selection.anchorX ?? window.innerWidth / 2}
            anchorY={selection.anchorY ?? 120}
            measureIdx={target.measureIdx}
            existingJumpMarkers={editedScore.jumpMarkers ?? []}
            segnoMarkers={editedScore.segnoMarkers ?? []}
            codaMarkers={editedScore.codaMarkers ?? []}
            measureCount={editedScore.measures.length}
            onClose={() => {
              setJumpMarkerOpen(false)
              setJumpMarkerTarget(null)
            }}
            onPatch={(patch: JumpMarkerPopoverPatch) => {
              if (patch.kind === 'insert') {
                const jumpMarker: {
                  measureIdx: number
                  side: 'start' | 'end'
                  kind: import('@/lib/music/types').JumpKind
                  segnoRef?: string
                  codaRef?: string
                  toCodaRef?: string
                } = {
                  measureIdx: patch.measureIdx,
                  side: patch.side,
                  kind: patch.jumpKind,
                }
                if (patch.segnoRef !== undefined) jumpMarker.segnoRef = patch.segnoRef
                if (patch.codaRef !== undefined) jumpMarker.codaRef = patch.codaRef
                if (patch.toCodaRef !== undefined) jumpMarker.toCodaRef = patch.toCodaRef
                applyEdit({ kind: 'insertJumpMarker', jumpMarker })
              } else {
                applyEdit({ kind: 'removeJumpMarker', id: patch.id })
              }
            }}
          />
        )
      })()}
    </div>
  )
}

/**
 * Build the dropdown options for hairpin end-event selection. Walks
 * the voice's events starting at (measureIdx, eventIdx) and emits a
 * label per id-bearing event. Excludes events without an id (the
 * hairpin schema requires stable endpoints).
 *
 * Cap prevents very long pieces from producing 1000-entry dropdowns;
 * 60 covers the vast majority of natural hairpin lengths.
 */
/**
 * Build an eventId → "m<N> b<M>" position label map for the given
 * voice. Used by the hairpin popover's summary so existing-hairpins
 * chips show start→end positions, distinguishing wedges on the same
 * voice. Skips events without an id (they can't be hairpin endpoints).
 */
function buildEventPositions(
  score: import('@/lib/music/types').Score,
  staffIdx: number,
  voiceIdx: number,
): Map<string, string> {
  const out = new Map<string, string>()
  const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
  for (let mi = 0; mi < measures.length; mi++) {
    const events = measures[mi].events
    for (let ei = 0; ei < events.length; ei++) {
      const id = events[ei].id
      if (id) out.set(id, `m${mi + 1} b${ei + 1}`)
    }
  }
  return out
}

function buildAvailableEnds(
  score: import('@/lib/music/types').Score,
  staffIdx: number,
  voiceIdx: number,
  startMeasureIdx: number,
  startEventIdx: number,
  cap: number,
): HairpinEndOption[] {
  const out: HairpinEndOption[] = []
  const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
  for (let mi = startMeasureIdx; mi < measures.length && out.length < cap; mi++) {
    const events = measures[mi].events
    const firstEvent = mi === startMeasureIdx ? startEventIdx : 0
    for (let ei = firstEvent; ei < events.length && out.length < cap; ei++) {
      const ev = events[ei]
      if (!ev.id) continue
      // Defensive: schema requires pitches.length >= 1, but a
      // malformed in-memory event would otherwise crash render.
      const firstPitch = ev.pitches[0]
      const pitchLbl = !firstPitch
        ? '—'
        : firstPitch.step === 'rest'
          ? 'rest'
          : `${firstPitch.step}${firstPitch.octave}`
      const isStart = mi === startMeasureIdx && ei === startEventIdx
      const tag = isStart ? ' (same note)' : ''
      out.push({
        eventId: ev.id,
        label: `m${mi + 1} b${ei + 1} — ${pitchLbl} (${ev.duration})${tag}`,
      })
    }
  }
  return out
}

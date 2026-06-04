async function loadAbcjs() {
  const mod = await import('abcjs')
  return (mod as unknown as { default?: typeof mod }).default ?? mod
}

type AbcjsModule = {
  renderAbc: (t: HTMLElement, abc: string, opts?: unknown) => unknown[]
  synth: {
    supportsAudio: () => boolean
    SynthController: new () => {
      load: (target: HTMLElement, cursor: unknown, opts: unknown) => void
      setTune: (visualObj: unknown, restart: boolean, opts: unknown) => Promise<unknown>
    }
    CreateSynth: new () => {
      init: (opts: { visualObj: unknown; options?: Record<string, unknown> }) => Promise<unknown>
    }
  }
}

export interface ClickListenerDrag {
  /** Staff-step delta from drag start. Screen-positive (down) so
   *  invert for pitch. Non-zero only on drag-end; abcjs renders the
   *  in-progress translate itself. */
  step: number
  max: number
  index: number
  setSelection: (i: number) => void
}

export interface RenderScoreOptions {
  /**
   * Make the SVG fluid. abcjs emits a `viewBox` + `width:100%` wrapper
   * so the score always fills its container width and never overflows
   * horizontally. renderScore keeps this ON for every on-screen render
   * (see the body), which is why there is no `scale` option — abcjs
   * ignores `scale` under responsive. Default: 'resize'.
   */
  responsive?: 'resize'
  /**
   * Layout width (px) abcjs lays each system out to BEFORE the
   * responsive wrapper scales the result to the container. This is the
   * editor's **zoom lever**: a smaller staffwidth packs fewer measures
   * per line, so the responsive scale-to-fit magnifies them (zoom in);
   * a larger staffwidth packs more, shrinking them (zoom out) — all
   * with zero horizontal overflow. See `staffwidthForZoom` in
   * `@/lib/editor/prefsStore`. Unset → abcjs's native 740px screen
   * default (≈ zoom 1.0).
   */
  staffwidth?: number
  /** Enable native abcjs drag-to-pitch on notes. */
  dragging?: boolean
  /** Elements selectable + draggable. Default: ['note']. */
  selectTypes?: Array<'note' | 'rest' | 'bar'>
  /** Color applied to a note while it's being dragged. */
  dragColor?: string
  /**
   * Equalize system widths so every measure expands to match the widest
   * measure in the score (uniform measure widths, aligned right margin).
   *
   * abcjs justifies each system independently to `staffwidth`, but a
   * dense system (e.g. a bar of 16ths) cannot be compressed below its
   * natural minimum width, while a sparse system (a bar of quarters) is
   * justified down to `staffwidth`. The result is ragged: dense systems
   * render wider per-measure than sparse ones. abcjs's `expandToWidest`
   * re-lays every system to the WIDEST system's width (see
   * abcjs/src/write/layout/layout.js:26-30), so all measures of equal
   * duration come out the same width and every system shares one right
   * margin. With `responsive: 'resize'` the widened layout is scaled to
   * fit the container, so there's no horizontal overflow.
   *
   * Default: true. Pass false to restore abcjs's per-system justification.
   */
  expandToWidest?: boolean
  // abcjs invokes this with the clicked notation element on user click.
  // The element has `startChar` / `endChar` into the ABC source.
  // On drag-end, the `drag` argument carries the staff-step delta.
  clickListener?: (
    abcElem: unknown,
    tuneNumber: number,
    classes: unknown,
    analysis: unknown,
    drag: ClickListenerDrag | undefined,
    mouseEvent: MouseEvent,
  ) => void
}

/**
 * Pure render: draws the ABC SVG into `target` and returns the abcjs
 * visualObj (the parsed tune). No synth side effects — call
 * `attachSynth` separately if/when audio playback is needed.
 *
 * Browser-only.
 */
export async function renderScore(
  target: HTMLElement,
  abc: string,
  opts: RenderScoreOptions = {},
): Promise<unknown> {
  const abcjs = (await loadAbcjs()) as unknown as AbcjsModule
  // add_classes: true makes abcjs emit grouping classes on outer
  // elements (.abcjs-note on each note <g>, .abcjs-staff on the staff
  // group, .abcjs-rest, .abcjs-bar, .abcjs-l<n>, .abcjs-m<n>). Without
  // it, only sub-element classes (abcjs-notehead, abcjs-stem) appear
  // and our DOM selectors for hit-testing notes and the staff fail.
  //
  // Always render responsive ('resize'): abcjs sizes the SVG with a
  // viewBox + width:100% wrapper, so it fits the container width and
  // never scrolls horizontally. abcjs deliberately IGNORES its `scale`
  // parameter under responsive (engraver-controller.js:214 — "The
  // resizing will mess with the scaling, so just don't do it
  // explicitly"), which is exactly why zoom is driven by `staffwidth`,
  // not `scale`: a narrower staffwidth reflows to fewer measures per
  // line and the responsive scale-to-fit then magnifies them. See
  // `staffwidthForZoom` in `@/lib/editor/prefsStore`.
  const responsive = opts.responsive ?? 'resize'
  // Default-on: equalize measure widths across systems. See the
  // expandToWidest doc on RenderScoreOptions for the full rationale.
  const expandToWidest = opts.expandToWidest ?? true
  const visualObjs = abcjs.renderAbc(target, abc, {
    ...(responsive ? { responsive } : {}),
    add_classes: true,
    ...(expandToWidest ? { expandToWidest: true } : {}),
    ...(opts.staffwidth !== undefined ? { staffwidth: opts.staffwidth } : {}),
    ...(opts.dragging ? { dragging: true } : {}),
    ...(opts.selectTypes ? { selectTypes: opts.selectTypes } : {}),
    ...(opts.dragColor ? { dragColor: opts.dragColor } : {}),
    ...(opts.clickListener ? { clickListener: opts.clickListener } : {}),
  })
  return visualObjs[0]
}

/**
 * Mount abcjs's built-in synth controller (play/restart/progress) into
 * `synthTarget`, bound to a previously-rendered `visualObj`.
 *
 * If the runtime has no audio support, leaves a message in the target.
 * Browser-only.
 */
export async function attachSynth(
  visualObj: unknown,
  synthTarget: HTMLElement,
): Promise<void> {
  const abcjs = (await loadAbcjs()) as unknown as AbcjsModule

  if (!abcjs.synth.supportsAudio()) {
    synthTarget.textContent = 'Audio not supported in this browser.'
    return
  }

  const synthControl = new abcjs.synth.SynthController()
  synthControl.load(synthTarget, null, {
    displayLoop: false,
    displayRestart: true,
    displayPlay: true,
    displayProgress: true,
    displayWarp: false,
  })

  const createSynth = new abcjs.synth.CreateSynth()
  // chordsOff: match the notation — suppress abcjs's auto-generated
  // bass+chord accompaniment derived from chord symbols. See
  // src/components/transport/useTransport.ts for the full rationale.
  await createSynth.init({ visualObj, options: { chordsOff: true } })
  await synthControl.setTune(visualObj, false, { chordsOff: true })
}

/**
 * Convenience: render the score AND mount the synth in one call.
 * Used by the existing ScorePanel until it's refactored to control
 * synth lifecycle independently from edit re-renders.
 */
export async function renderAndAttachSynth(
  scoreTarget: HTMLElement,
  synthTarget: HTMLElement | null,
  abc: string,
  opts: RenderScoreOptions = {},
): Promise<void> {
  const visualObj = await renderScore(scoreTarget, abc, opts)
  if (synthTarget) await attachSynth(visualObj, synthTarget)
}

async function loadAbcjs() {
  const mod = await import('abcjs')
  return (mod as unknown as { default?: typeof mod }).default ?? mod
}

/**
 * Generate the MIDI binary for an ABC string.
 *
 * abcjs v6's `getMidiFile(abc, { midiOutputType: 'binary' })` returns
 * an Array<Uint8Array> with one entry per X-indexed tune in the input.
 * We expect (and only emit) a single tune, so we take [0].
 *
 * Throws if abcjs cannot produce MIDI for the input.
 */
export async function getMidiBytes(abc: string): Promise<Uint8Array> {
  const abcjs = await loadAbcjs()
  const result = (abcjs as unknown as {
    synth: {
      getMidiFile: (
        abc: string,
        opts: { midiOutputType: string; chordsOff?: boolean },
      ) => Array<Uint8Array>
    }
    // chordsOff: don't bake abcjs's auto-generated bass+chord
    // accompaniment (a hidden rhythm track derived from chord symbols)
    // into the exported MIDI — it isn't part of the notation. See
    // src/components/transport/useTransport.ts for the same rationale.
  }).synth.getMidiFile(abc, { midiOutputType: 'binary', chordsOff: true })

  if (!Array.isArray(result) || !(result[0] instanceof Uint8Array) || result[0].byteLength === 0) {
    throw new Error('abcjs failed to produce MIDI bytes')
  }
  return result[0]
}

/**
 * Trigger a browser download of the MIDI file. Browser-only.
 */
export async function downloadMidi(abc: string, filename = 'score.mid'): Promise<void> {
  const bytes = await getMidiBytes(abc)
  const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/midi' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    URL.revokeObjectURL(url)
  }
}

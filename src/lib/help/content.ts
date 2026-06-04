// User-facing help content. Plain data so the quick-start modal, the
// /help route, and the style-guard test all read from one source.
//
// House style: third person or imperative, never "you"/"your";
// contractions are fine; concrete over vague; no AI-cliché filler.
// The prose sections live in sections.json (clean Markdown escaping);
// the keyboard reference and quick start are authored here.

import sectionsData from './sections.json'

export interface HelpSection {
  id: string
  title: string
  /** GitHub-flavored Markdown. Always starts with a `## ` heading. */
  body: string
}

export interface QuickStartStep {
  title: string
  body: string
}

export const QUICK_START_INTRO =
  'sheet-llm turns plain-language requests into real notation. The short version:'

export const QUICK_START_STEPS: QuickStartStep[] = [
  {
    title: 'Describe the music',
    body: 'Type a request like "a short waltz in A minor" in the prompt bar and press Enter.',
  },
  {
    title: 'Refine in chat',
    body: 'Ask for changes: "add 4 bars", "rewrite bars 5-8", "make bar 2 staccato". Bars the request never mentions stay exactly as they were.',
  },
  {
    title: 'Review AI edits',
    body: 'Small changes preview in amber. Press Enter to keep them or Esc to discard.',
  },
  {
    title: 'Edit by hand',
    body: 'Click any note, then reach for the floating menu, the arrow keys, or the command palette.',
  },
  {
    title: 'Play and export',
    body: 'Press Space to play. Buttons below the score export to MIDI, PDF, and MusicXML.',
  },
]

export const QUICK_START_FOOTER =
  'Press ? for the keyboard-shortcut sheet, or Cmd/Ctrl+K for the command palette.'

// Authored here (not in sections.json) because it's a deterministic
// reference that should track the keyboard map exactly. Keys are bold,
// not inline code, so the source stays free of backticks.
const SHORTCUTS: HelpSection = {
  id: 'keyboard-shortcuts',
  title: 'Keyboard shortcuts',
  body: `## Keyboard shortcuts

Most shortcuts work while a note is selected. On a Mac, use **Cmd** wherever **Ctrl** is shown.

### Getting around

| Action | Keys |
| --- | --- |
| Open the command palette | **Cmd/Ctrl+K** |
| Open the shortcut sheet | **?** |
| Show or hide chat history (narrow screens) | **Cmd/Ctrl+/** |
| Zoom the score | **Cmd/Ctrl + scroll**, or pinch |
| Clear selection, close a menu, cancel a drag | **Esc** |

### Select and move notes

| Action | Keys |
| --- | --- |
| Select a note or rest | Click |
| Up or down a step | **↑** / **↓** |
| Up or down an octave | **Shift+↑** / **Shift+↓** |
| Retune by dragging | Vertical drag (hold **Shift** for octaves) |
| Move a note, even across a barline | Horizontal drag |

### Note duration

| Action | Keys |
| --- | --- |
| 32nd, 16th, eighth | **1**, **2**, **3** |
| Quarter, half, whole | **4**, **5**, **6** |
| Toggle a dot | **.** |

### Accidentals

| Action | Keys |
| --- | --- |
| Sharp, flat, natural | **=**, **-**, **0** |

### Chords

| Action | Keys |
| --- | --- |
| Open the chord palette | **c** |
| Stack a pitch into the chord | **Shift+A** … **Shift+G** |
| Add a pitch at the click height | **Shift+click** |
| Force a new note instead of stacking | **Alt+click** |

### Measures and edits

| Action | Keys |
| --- | --- |
| Select a measure | **Cmd/Ctrl+click** a bar |
| Extend the selection | **Cmd/Ctrl+Shift+click** a bar |
| Move the selected range | Drag it |
| Duplicate measures | **Cmd/Ctrl+D** |
| Delete measures (asks first) | **Shift+Delete** / **Shift+Backspace** |
| Delete the selected note | **Delete** / **Backspace** |
| Undo, redo | **Cmd/Ctrl+Z**, **Cmd/Ctrl+Shift+Z** |

### Marks on the selected note

| Mark | Keys |
| --- | --- |
| Dynamics | **Shift+D** |
| Performance technique | **Shift+P** |
| Fingering | **Shift+F** |
| Ornaments | **Shift+O** |
| Grace notes | **Shift+R** |
| Text or rehearsal mark | **Shift+T** |
| Mid-piece marker (key, meter, tempo, clef) | **Shift+M** |
| Chord symbol | **Shift+H** |
| Lyrics | **Shift+V** |
| Tie | **Shift+I** |

### Lines and spans

| Span | Keys |
| --- | --- |
| Hairpin (cresc. or dim.) | **Shift+W** |
| Slur or phrase slur | **Shift+S** |
| Tempo span (accel. or rit.) | **Shift+L** |
| Octave span (8va, 8vb) | **Shift+U** |
| Glissando | **Shift+G** |
| Trill line | **Shift+Z** |
| Tremolo between notes | **Shift+X** |

### Bars and repeats

| Action | Keys |
| --- | --- |
| Barline | **Shift+J** |
| Volta (1st or 2nd ending) | **Shift+K** |
| Jump marker (D.C., D.S., Coda) | **Shift+Y** |

### Playback

| Action | Keys |
| --- | --- |
| Play or pause | **Space** |
| Restart | **Home** |
| Seek by measure (scrubber focused) | **←** / **→** |
| Seek by beat | **Shift+←** / **Shift+→** |

### Prompt bar

| Action | Keys |
| --- | --- |
| Previous or next prompt | **↑** / **↓** |
| Send | **Enter** |`,
}

const prose = sectionsData as HelpSection[]
const byId = new Map(prose.map((s) => [s.id, s]))

function need(id: string): HelpSection {
  const section = byId.get(id)
  if (!section) throw new Error(`help: missing section "${id}" in sections.json`)
  return section
}

// Final display order. Keyboard shortcuts sit after the command palette,
// between the editing chapters and playback.
export const HELP_SECTIONS: HelpSection[] = [
  need('overview'),
  need('composing-with-ai'),
  need('editing-notes'),
  need('marks-expression'),
  need('structure-layout'),
  need('command-palette'),
  SHORTCUTS,
  need('playback'),
  need('import-export'),
  need('sessions-settings-tips'),
]

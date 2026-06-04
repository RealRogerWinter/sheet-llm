import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ExportBar from '@/components/ExportBar'
import type { Score } from '@/lib/music/types'

// Stub the download libs so the buttons don't try to invoke abcjs
// in jsdom (which would fail measuring text width via canvas).
vi.mock('@/lib/abc/midi', () => ({ downloadMidi: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/abc/pdf', () => ({ downloadPdf: vi.fn().mockResolvedValue(undefined) }))
const downloadMusicXmlMock = vi.fn()
vi.mock('@/lib/music/export/musicxml', () => ({
  // scoreToMusicXml is unused at this level; download is the entry point
  // ExportBar calls. Stub it to capture the args.
  downloadMusicXml: (...args: unknown[]) => downloadMusicXmlMock(...args),
}))

const ABC = 'X:1\nT:Test\nM:4/4\nL:1/8\nK:C\nC8|]'
const SCORE: Score = {
  title: 'Test',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
  ],
}

beforeEach(() => {
  cleanup()
  downloadMusicXmlMock.mockReset()
})

describe('<ExportBar />', () => {
  it('renders MIDI and PDF buttons unconditionally', () => {
    render(<ExportBar abc={ABC} title="Test" />)
    expect(screen.getByRole('button', { name: 'Download MIDI' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument()
  })

  it('hides the MusicXML button when no score is provided', () => {
    render(<ExportBar abc={ABC} title="Test" />)
    expect(screen.queryByRole('button', { name: 'Download MusicXML' })).toBeNull()
  })

  it('shows the MusicXML button when a score is provided', () => {
    render(<ExportBar abc={ABC} title="Test" score={SCORE} />)
    expect(screen.getByRole('button', { name: 'Download MusicXML' })).toBeInTheDocument()
  })

  it('clicking MusicXML calls downloadMusicXml with the score + safe filename', () => {
    render(<ExportBar abc={ABC} title="My Piece!" score={SCORE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download MusicXML' }))
    expect(downloadMusicXmlMock).toHaveBeenCalledTimes(1)
    expect(downloadMusicXmlMock).toHaveBeenCalledWith(SCORE, 'my-piece.musicxml')
  })

  it('defaults filename to "score.musicxml" when title is undefined', () => {
    render(<ExportBar abc={ABC} score={SCORE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download MusicXML' }))
    expect(downloadMusicXmlMock).toHaveBeenCalledWith(SCORE, 'score.musicxml')
  })

  it('strips non-alphanumeric characters from the title to make a safe filename', () => {
    render(<ExportBar abc={ABC} title="Über schön! 🎶" score={SCORE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download MusicXML' }))
    // Emoji and umlaut chars collapse into hyphens; the regex strips
    // them down to a-z 0-9 plus hyphens, with leading/trailing hyphens
    // trimmed. All non-ASCII collapses to a single hyphen run.
    const [, filename] = downloadMusicXmlMock.mock.calls[0]
    expect(filename).toBe('ber-sch-n.musicxml')
  })

  it('shows an alert when downloadMusicXml throws', () => {
    downloadMusicXmlMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    render(<ExportBar abc={ABC} title="Test" score={SCORE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download MusicXML' }))
    expect(screen.getByRole('alert')).toHaveTextContent('disk full')
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ScoreMetadataPopover from '@/components/editor/ScoreMetadataPopover'
import type { Score } from '@/lib/music/types'

afterEach(() => cleanup())

const EMPTY_CURRENT: Pick<Score, 'title' | 'composer' | 'arranger' | 'lyricist' | 'copyright'> = {
  title: undefined,
  composer: undefined,
  arranger: undefined,
  lyricist: undefined,
  copyright: undefined,
}

const FULL_CURRENT: Pick<Score, 'title' | 'composer' | 'arranger' | 'lyricist' | 'copyright'> = {
  title: 'Invention 1',
  composer: 'J. S. Bach',
  arranger: undefined,
  lyricist: undefined,
  copyright: 'Public Domain',
}

describe('ScoreMetadataPopover — render', () => {
  it('renders all 5 metadata fields when open', () => {
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Composer' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Arranger' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Lyricist' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Copyright' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <ScoreMetadataPopover
        open={false}
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('seeds fields with the current values', () => {
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={FULL_CURRENT}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Invention 1')
    expect((screen.getByRole('textbox', { name: 'Composer' }) as HTMLInputElement).value).toBe('J. S. Bach')
    expect((screen.getByRole('textbox', { name: 'Arranger' }) as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('textbox', { name: 'Copyright' }) as HTMLInputElement).value).toBe('Public Domain')
  })
})

describe('ScoreMetadataPopover — Save semantics', () => {
  it('Save is disabled when nothing changed', () => {
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={FULL_CURRENT}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('Save becomes enabled after any field changes', () => {
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const composer = screen.getByRole('textbox', { name: 'Composer' }) as HTMLInputElement
    fireEvent.change(composer, { target: { value: 'Bach' } })
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
  })

  it('Save emits a patch with only the changed fields', () => {
    const onSubmit = vi.fn()
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Sketch' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Composer' }), { target: { value: 'Bach' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith({ title: 'Sketch', composer: 'Bach' })
  })

  it('clearing an existing field emits null (encodes "clear" for setScoreMetadata)', () => {
    const onSubmit = vi.fn()
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={FULL_CURRENT}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    // Clear the composer field; leave others alone.
    fireEvent.change(screen.getByRole('textbox', { name: 'Composer' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith({ composer: null })
  })

  it('whitespace-only input is treated as cleared (trim before patch)', () => {
    const onSubmit = vi.fn()
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={FULL_CURRENT}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Composer' }), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith({ composer: null })
  })

  it('legacy whitespace in current value does NOT spuriously enable Save (trim applied to both sides)', () => {
    // If a legacy edit left composer as "Bach ", opening the popover
    // would otherwise show Save enabled with no user input — and
    // submit would emit a no-op-looking { composer: 'Bach' } patch.
    // The form trims both `values[k]` and `current[k]` before diff.
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={{ ...EMPTY_CURRENT, composer: 'Bach ' }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('typing the SAME value as current is a no-op (no field in the patch)', () => {
    const onSubmit = vi.fn()
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={FULL_CURRENT}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    // Type into composer the same value; should not enable Save.
    const composer = screen.getByRole('textbox', { name: 'Composer' }) as HTMLInputElement
    fireEvent.change(composer, { target: { value: 'J. S. Bach' } })
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('Enter key inside any field submits when there are changes', () => {
    const onSubmit = vi.fn()
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    const composer = screen.getByRole('textbox', { name: 'Composer' }) as HTMLInputElement
    fireEvent.change(composer, { target: { value: 'Bach' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ composer: 'Bach' })
  })

  it('Enter with no changes does NOT submit', () => {
    const onSubmit = vi.fn()
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={FULL_CURRENT}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ScoreMetadataPopover — field length caps', () => {
  it('Title input enforces maxLength 80 (Score.title schema)', () => {
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const title = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement
    expect(title.maxLength).toBe(80)
  })

  it('Composer / Arranger / Lyricist inputs enforce maxLength 120', () => {
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    for (const label of ['Composer', 'Arranger', 'Lyricist']) {
      expect((screen.getByRole('textbox', { name: label }) as HTMLInputElement).maxLength).toBe(120)
    }
  })

  it('Copyright input enforces maxLength 200', () => {
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect((screen.getByRole('textbox', { name: 'Copyright' }) as HTMLInputElement).maxLength).toBe(200)
  })
})

describe('ScoreMetadataPopover — Cancel', () => {
  it('Cancel calls onClose without emitting a patch', () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn()
    render(
      <ScoreMetadataPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Drafted then cancelled' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

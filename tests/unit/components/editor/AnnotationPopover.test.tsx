import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import AnnotationPopover from '@/components/editor/AnnotationPopover'
import type { Annotation } from '@/lib/music/types'

afterEach(() => cleanup())

function makeAnnotation(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'rehearseAA',
    target: { measureIdx: 0, position: 'above' },
    text: 'A',
    style: 'rehearsal-mark',
    ...over,
  }
}

describe('AnnotationPopover — render', () => {
  it('renders the four sections when open', () => {
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Annotation text' })).toBeDefined()
    expect(screen.getByRole('radiogroup', { name: 'Style' })).toBeDefined()
    expect(screen.getByRole('radiogroup', { name: 'Position' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <AnnotationPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('omits "On this event" section when there are no existing annotations', () => {
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('list', { name: 'Existing annotations' })).toBeNull()
  })

  it('lists existing annotations with their text + style + remove buttons', () => {
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[
          makeAnnotation({ id: 'rehearseAA', text: 'A', style: 'rehearsal-mark' }),
          makeAnnotation({ id: 'tempo00001', text: 'Allegro', style: 'tempo-text' }),
        ]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const list = screen.getByRole('list', { name: 'Existing annotations' })
    expect(list.textContent).toContain('A')
    expect(list.textContent).toContain('rehearsal-mark')
    expect(list.textContent).toContain('Allegro')
    expect(list.textContent).toContain('tempo-text')
    expect(screen.getAllByRole('button', { name: /Remove annotation/ })).toHaveLength(2)
  })
})

describe('AnnotationPopover — apply', () => {
  it('Apply is disabled when text is empty', () => {
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply is enabled once text is non-empty', () => {
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Annotation text' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'A' } })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)
  })

  it('whitespace-only text leaves Apply disabled (trim semantics)', () => {
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Annotation text' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply emits an insert patch with the current text/style/position', () => {
    const onPatch = vi.fn()
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Annotation text' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '  Allegro  ' } })
    // Default style is "expression" — switch to tempo-text to lock the
    // form behavior.
    fireEvent.click(screen.getByRole('radio', { name: 'Tempo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // Text is trimmed before emitting.
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      text: 'Allegro',
      style: 'tempo-text',
      position: 'above',
    })
  })

  it('Enter inside the text input submits the form', () => {
    const onPatch = vi.fn()
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Annotation text' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      text: 'A',
      style: 'expression',
      position: 'above',
    })
  })

  it('clears the text field after a successful Apply (for repeated entry)', () => {
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Annotation text' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(input.value).toBe('')
  })

  it('keeps style + position sticky across successive Applies (user can add 3 rehearsal marks fast)', () => {
    const onPatch = vi.fn()
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Rehearsal' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Below' }))
    const input = screen.getByRole('textbox', { name: 'Annotation text' }) as HTMLInputElement

    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.change(input, { target: { value: 'B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onPatch).toHaveBeenCalledTimes(2)
    expect(onPatch).toHaveBeenNthCalledWith(1, {
      kind: 'insert',
      text: 'A',
      style: 'rehearsal-mark',
      position: 'below',
    })
    expect(onPatch).toHaveBeenNthCalledWith(2, {
      kind: 'insert',
      text: 'B',
      style: 'rehearsal-mark',
      position: 'below',
    })
  })
})

describe('AnnotationPopover — remove', () => {
  it('clicking × on an existing annotation emits a remove patch with that id', () => {
    const onPatch = vi.fn()
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[
          makeAnnotation({ id: 'rehearseAA', text: 'A', style: 'rehearsal-mark' }),
          makeAnnotation({ id: 'tempo00001', text: 'Allegro', style: 'tempo-text' }),
        ]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove annotation "Allegro"' }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'remove', id: 'tempo00001' })
  })
})

describe('AnnotationPopover — Cancel + Done', () => {
  it('Cancel calls onClose without emitting a patch', () => {
    const onClose = vi.fn()
    const onPatch = vi.fn()
    render(
      <AnnotationPopover
        open
        anchorX={400}
        anchorY={100}
        existingAnnotations={[]}
        onClose={onClose}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onPatch).not.toHaveBeenCalled()
  })
})

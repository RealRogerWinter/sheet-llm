import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import GlissandoPopover, {
  type GlissandoEndOption,
  type GlissandoPopoverPatch,
} from '@/components/editor/GlissandoPopover'
import type { Span } from '@/lib/music/types'

afterEach(() => cleanup())

const endOptions: GlissandoEndOption[] = [
  { eventId: 'evtestid02', label: 'm1 b2 — D4 (quarter)' },
  { eventId: 'evtestid03', label: 'm1 b3 — E4 (quarter)' },
]

function makeGlissando(
  over: Partial<Span> = {},
): Span & { kind: 'glissando' } {
  return {
    id: 'glissaaaa1',
    kind: 'glissando',
    startEventId: 'evtestid01',
    endEventId: 'evtestid02',
    staffIdx: 0,
    voiceIdx: 0,
    ...over,
  } as Span & { kind: 'glissando' }
}

describe('GlissandoPopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <GlissandoPopover
        open
        anchorX={400}
        anchorY={100}
        existingGlissandos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'End event' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Glissando style' })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /gliss.*text label/i })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Placement' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <GlissandoPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingGlissandos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists existing glissandos with summaries + remove buttons', () => {
    render(
      <GlissandoPopover
        open
        anchorX={400}
        anchorY={100}
        existingGlissandos={[
          makeGlissando(),
          makeGlissando({ id: 'glissbbbb2', glissStyle: 'wavy', glissText: true }),
        ]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('list', { name: 'Existing glissandos' })).toBeDefined()
    const removeButtons = screen.getAllByRole('button', { name: /Remove glissando/i })
    expect(removeButtons).toHaveLength(2)
  })
})

describe('GlissandoPopover — submit', () => {
  it('emits a minimal insert (just endEventId)', () => {
    const onPatch = vi.fn()
    render(
      <GlissandoPopover
        open
        anchorX={400}
        anchorY={100}
        existingGlissandos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: 'evtestid02' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      endEventId: 'evtestid02',
    } satisfies GlissandoPopoverPatch)
  })

  it('emits insert with glissStyle + glissText', () => {
    const onPatch = vi.fn()
    render(
      <GlissandoPopover
        open
        anchorX={400}
        anchorY={100}
        existingGlissandos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Glissando style' }), {
      target: { value: 'wavy' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /gliss.*text label/i }))
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: 'evtestid02' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      endEventId: 'evtestid02',
      glissStyle: 'wavy',
      glissText: true,
    } satisfies GlissandoPopoverPatch)
  })

  it('disables Apply when no end event is available', () => {
    render(
      <GlissandoPopover
        open
        anchorX={400}
        anchorY={100}
        existingGlissandos={[]}
        availableEnds={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: /Apply/i })
    expect((apply as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('GlissandoPopover — remove', () => {
  it('emits remove with the span id when × clicked', () => {
    const onPatch = vi.fn()
    render(
      <GlissandoPopover
        open
        anchorX={400}
        anchorY={100}
        existingGlissandos={[makeGlissando()]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove glissando/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'remove',
      id: 'glissaaaa1',
    } satisfies GlissandoPopoverPatch)
  })
})

describe('GlissandoPopover — re-seed on reopen', () => {
  it('resets the form when transitioning closed → open', async () => {
    const { rerender } = render(
      <GlissandoPopover
        open
        anchorX={400}
        anchorY={100}
        existingGlissandos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const checkbox = screen.getByRole('checkbox', { name: /gliss.*text label/i }) as HTMLInputElement
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    await act(async () => {
      rerender(
        <GlissandoPopover
          open={false}
          anchorX={400}
          anchorY={100}
          existingGlissandos={[]}
          availableEnds={endOptions}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    await act(async () => {
      rerender(
        <GlissandoPopover
          open
          anchorX={400}
          anchorY={100}
          existingGlissandos={[]}
          availableEnds={endOptions}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    const reseededCheckbox = screen.getByRole('checkbox', { name: /gliss.*text label/i }) as HTMLInputElement
    expect(reseededCheckbox.checked).toBe(false)
  })
})

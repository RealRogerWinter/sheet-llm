import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import JumpMarkerPopover, {
  type JumpMarkerPopoverPatch,
} from '@/components/editor/JumpMarkerPopover'
import type { CodaMarker, JumpMarker, SegnoMarker } from '@/lib/music/types'

afterEach(() => cleanup())

const baseProps = {
  open: true as const,
  anchorX: 400,
  anchorY: 100,
  measureIdx: 2,
  existingJumpMarkers: [] as ReadonlyArray<JumpMarker>,
  segnoMarkers: [] as ReadonlyArray<SegnoMarker>,
  codaMarkers: [] as ReadonlyArray<CodaMarker>,
  measureCount: 8,
  onClose: vi.fn(),
  onPatch: vi.fn(),
}

describe('JumpMarkerPopover — render', () => {
  it('renders form fields when open', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    expect(screen.getByRole('combobox', { name: 'Jump kind' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: /Measure/i })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Side' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(<JumpMarkerPopover {...baseProps} open={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('header includes the measure number (1-indexed)', () => {
    render(<JumpMarkerPopover {...baseProps} measureIdx={4} />)
    expect(screen.getByText(/measure 5/i)).toBeDefined()
  })

  it('defaults kind to D.C. and side to end', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    const kind = screen.getByRole('combobox', { name: 'Jump kind' }) as HTMLSelectElement
    const side = screen.getByRole('combobox', { name: 'Side' }) as HTMLSelectElement
    expect(kind.value).toBe('D.C.')
    expect(side.value).toBe('end')
  })

  it('defaults measure to the anchor measure (1-indexed)', () => {
    render(<JumpMarkerPopover {...baseProps} measureIdx={3} />)
    const m = screen.getByRole('textbox', { name: /Measure/i }) as HTMLInputElement
    expect(m.value).toBe('4')
  })

  it('lists all 8 JumpKind options', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    const kind = screen.getByRole('combobox', { name: 'Jump kind' })
    expect(kind.querySelectorAll('option').length).toBe(8)
    // Spot-check a few values.
    expect(screen.getByText('D.C. al Coda')).toBeDefined()
    expect(screen.getByText('To Coda')).toBeDefined()
    expect(screen.getByText('Fine')).toBeDefined()
  })
})

describe('JumpMarkerPopover — Segno gating', () => {
  it('Segno selector is HIDDEN by default (kind=D.C., no segnoRef required)', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    expect(screen.queryByRole('combobox', { name: 'Segno reference' })).toBeNull()
  })

  it('Segno selector appears when kind=D.S.', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.S.' },
    })
    expect(screen.getByRole('combobox', { name: 'Segno reference' })).toBeDefined()
  })

  it('Segno selector lists available Segnos', () => {
    const segno: SegnoMarker = { id: 'segnoxxx01', measureIdx: 1, side: 'start' }
    render(<JumpMarkerPopover {...baseProps} segnoMarkers={[segno]} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.S.' },
    })
    expect(screen.getByText(/Segno @ m2/)).toBeDefined()
  })

  it('Apply disabled when D.S. has no segnoRef selected', () => {
    const segno: SegnoMarker = { id: 'segnoxxx01', measureIdx: 1, side: 'start' }
    render(<JumpMarkerPopover {...baseProps} segnoMarkers={[segno]} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.S.' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply enabled once a segnoRef is selected for D.S.', () => {
    const segno: SegnoMarker = { id: 'segnoxxx01', measureIdx: 1, side: 'start' }
    render(<JumpMarkerPopover {...baseProps} segnoMarkers={[segno]} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.S.' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Segno reference' }), {
      target: { value: 'segnoxxx01' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)
  })

  it('warning banner appears when D.S.* kind selected and no Segnos in score', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.S.' },
    })
    expect(screen.getByText(/No Segno landmarks/i)).toBeDefined()
  })
})

describe('JumpMarkerPopover — Coda gating', () => {
  it('Coda selector appears for D.C. al Coda', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.C. al Coda' },
    })
    expect(screen.getByRole('combobox', { name: 'Coda reference' })).toBeDefined()
  })

  it('Coda selector lists available Codas', () => {
    const coda: CodaMarker = { id: 'codaxxxx01', measureIdx: 5, side: 'start' }
    render(<JumpMarkerPopover {...baseProps} codaMarkers={[coda]} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.C. al Coda' },
    })
    expect(screen.getByText(/Coda @ m6/)).toBeDefined()
  })

  it('To Coda gate selector appears for *.al-Coda when existing To Codas present', () => {
    const toCoda: JumpMarker = {
      id: 'tocodaaa01',
      measureIdx: 3,
      side: 'end',
      kind: 'To Coda',
    }
    render(<JumpMarkerPopover {...baseProps} existingJumpMarkers={[toCoda]} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.C. al Coda' },
    })
    expect(screen.getByRole('combobox', { name: 'To Coda gate' })).toBeDefined()
  })

  it('To Coda gate selector ABSENT when no To Codas in score', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.C. al Coda' },
    })
    expect(screen.queryByRole('combobox', { name: 'To Coda gate' })).toBeNull()
  })

  it('warning banner appears when *.al-Coda selected and no Codas in score', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.C. al Coda' },
    })
    expect(screen.getByText(/No Coda landmarks/i)).toBeDefined()
  })
})

describe('JumpMarkerPopover — Apply dispatch', () => {
  it('emits insert patch with kind=D.C. defaults on Apply', () => {
    const onPatch = vi.fn()
    render(<JumpMarkerPopover {...baseProps} onPatch={onPatch} measureIdx={3} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      measureIdx: 3, // 1-indexed input "4" → 3 in 0-indexed output
      side: 'end',
      jumpKind: 'D.C.',
    } satisfies JumpMarkerPopoverPatch)
  })

  it('emits insert with segnoRef for D.S.', () => {
    const segno: SegnoMarker = { id: 'segnotest1', measureIdx: 1, side: 'start' }
    const onPatch = vi.fn()
    render(
      <JumpMarkerPopover {...baseProps} segnoMarkers={[segno]} onPatch={onPatch} measureIdx={5} />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.S.' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Segno reference' }), {
      target: { value: 'segnotest1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      measureIdx: 5,
      side: 'end',
      jumpKind: 'D.S.',
      segnoRef: 'segnotest1',
    } satisfies JumpMarkerPopoverPatch)
  })

  it('emits insert with codaRef + toCodaRef for D.S. al Coda with gating', () => {
    const segno: SegnoMarker = { id: 'segnoxxx02', measureIdx: 1, side: 'start' }
    const coda: CodaMarker = { id: 'codaxxxx02', measureIdx: 4, side: 'start' }
    const toCoda: JumpMarker = {
      id: 'tocodaaa02',
      measureIdx: 2,
      side: 'end',
      kind: 'To Coda',
    }
    const onPatch = vi.fn()
    render(
      <JumpMarkerPopover
        {...baseProps}
        segnoMarkers={[segno]}
        codaMarkers={[coda]}
        existingJumpMarkers={[toCoda]}
        onPatch={onPatch}
        measureIdx={6}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.S. al Coda' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Segno reference' }), {
      target: { value: 'segnoxxx02' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Coda reference' }), {
      target: { value: 'codaxxxx02' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'To Coda gate' }), {
      target: { value: 'tocodaaa02' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      measureIdx: 6,
      side: 'end',
      jumpKind: 'D.S. al Coda',
      segnoRef: 'segnoxxx02',
      codaRef: 'codaxxxx02',
      toCodaRef: 'tocodaaa02',
    } satisfies JumpMarkerPopoverPatch)
  })

  it('emits insert with side=start when toggled', () => {
    const onPatch = vi.fn()
    render(<JumpMarkerPopover {...baseProps} onPatch={onPatch} measureIdx={0} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Side' }), {
      target: { value: 'start' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      measureIdx: 0,
      side: 'start',
      jumpKind: 'D.C.',
    } satisfies JumpMarkerPopoverPatch)
  })

  it('Apply disabled when measure out of range', () => {
    render(<JumpMarkerPopover {...baseProps} measureCount={5} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Measure/i }), {
      target: { value: '10' },
    })
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Apply disabled when measure=0 (out of 1-indexed range)', () => {
    render(<JumpMarkerPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Measure/i }), {
      target: { value: '0' },
    })
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Enter key in measure input submits the form', () => {
    const onPatch = vi.fn()
    render(<JumpMarkerPopover {...baseProps} onPatch={onPatch} measureIdx={1} />)
    const input = screen.getByRole('textbox', { name: /Measure/i })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPatch).toHaveBeenCalledTimes(1)
  })
})

describe('JumpMarkerPopover — existing list + remove', () => {
  it('lists jumpMarkers covering the anchor measure', () => {
    const existing: JumpMarker[] = [
      { id: 'jumpaaa001', measureIdx: 2, side: 'end', kind: 'D.C.' },
      { id: 'jumpbbb002', measureIdx: 5, side: 'end', kind: 'Fine' },
    ]
    render(
      <JumpMarkerPopover {...baseProps} measureIdx={2} existingJumpMarkers={existing} />,
    )
    // Only the m=2 jumpMarker appears in the list.
    expect(screen.getByText(/D\.C\. m3 \(end\)/)).toBeDefined()
    expect(screen.queryByText(/Fine m6/)).toBeNull()
  })

  it('clicking × emits a remove patch with the jumpMarker id', () => {
    const onPatch = vi.fn()
    const existing: JumpMarker[] = [
      { id: 'jumprmv001', measureIdx: 2, side: 'end', kind: 'D.C.' },
    ]
    render(
      <JumpMarkerPopover
        {...baseProps}
        measureIdx={2}
        existingJumpMarkers={existing}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove jumpMarker D\.C\./i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'remove',
      id: 'jumprmv001',
    } satisfies JumpMarkerPopoverPatch)
  })

  it('lists Segno + Coda landmarks anchored to the same measure as read-only rows (M18-PR-5 review)', () => {
    const segno: SegnoMarker = { id: 'segnoreadm', measureIdx: 4, side: 'start' }
    const coda: CodaMarker = { id: 'codareadm1', measureIdx: 4, side: 'start' }
    render(
      <JumpMarkerPopover
        {...baseProps}
        measureIdx={4}
        segnoMarkers={[segno]}
        codaMarkers={[coda]}
      />,
    )
    expect(screen.getByText(/Segno \(start\) — read-only/)).toBeDefined()
    expect(screen.getByText(/Coda \(start\) — read-only/)).toBeDefined()
  })

  it('hint banner appears when *.al-Coda selected and no To Coda candidates (M18-PR-5 review)', () => {
    const coda: CodaMarker = { id: 'codaforhin', measureIdx: 5, side: 'start' }
    render(<JumpMarkerPopover {...baseProps} codaMarkers={[coda]} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.C. al Coda' },
    })
    expect(screen.getByText(/No To Coda jumpMarkers yet/)).toBeDefined()
  })

  it('summarizes a jumpMarker with all 3 refs', () => {
    const existing: JumpMarker[] = [
      {
        id: 'jumpalrf01',
        measureIdx: 4,
        side: 'end',
        kind: 'D.S. al Coda',
        segnoRef: 'segnoaaa01',
        codaRef: 'codaaaaa01',
        toCodaRef: 'tocodaaa01',
      },
    ]
    render(
      <JumpMarkerPopover {...baseProps} measureIdx={4} existingJumpMarkers={existing} />,
    )
    expect(screen.getByText(/D\.S\. al Coda m5 \(end\) → Segno → Coda → To Coda/)).toBeDefined()
  })
})

describe('JumpMarkerPopover — re-seed on close→open transition', () => {
  it('after close+reopen, kind resets to D.C.', () => {
    const { rerender } = render(<JumpMarkerPopover {...baseProps} measureIdx={2} />)
    // Change kind, then close.
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump kind' }), {
      target: { value: 'D.S. al Fine' },
    })
    expect((screen.getByRole('combobox', { name: 'Jump kind' }) as HTMLSelectElement).value).toBe(
      'D.S. al Fine',
    )
    rerender(<JumpMarkerPopover {...baseProps} measureIdx={2} open={false} />)
    rerender(<JumpMarkerPopover {...baseProps} measureIdx={2} open={true} />)
    expect((screen.getByRole('combobox', { name: 'Jump kind' }) as HTMLSelectElement).value).toBe(
      'D.C.',
    )
  })
})

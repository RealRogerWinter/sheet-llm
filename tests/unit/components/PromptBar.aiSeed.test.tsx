import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import PromptBar from '@/components/PromptBar'
import { useChatStore } from '@/lib/chat/state'

// Capture submit() args so the D5 region pass-through is observable without
// a real network round-trip.
const { submitSpy } = vi.hoisted(() => ({ submitSpy: vi.fn() }))
vi.mock('@/lib/chat/useSubmitPrompt', () => ({
  useSubmitPrompt: () => ({ submit: submitSpy, pending: false, error: undefined }),
}))

describe('PromptBar aiSeed subscription (M29-PR-1 / D5)', () => {
  beforeEach(() => {
    submitSpy.mockReset()
    submitSpy.mockResolvedValue({ ok: true })
    useChatStore.setState({ aiSeed: undefined })
  })

  it('pre-fills + focuses the input when seedAiInput fires (without sending)', () => {
    render(<PromptBar />)
    const input = screen.getByLabelText('Music request') as HTMLInputElement
    expect(input.value).toBe('')

    act(() => {
      useChatStore.getState().seedAiInput('In measure 5, ')
    })

    expect(input.value).toBe('In measure 5, ')
    expect(document.activeElement).toBe(input)
    // It only seeds — the request is not sent.
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('attaches the armed targetRegion to submit when the input still derives from the seed (D5)', async () => {
    render(<PromptBar />)
    const input = screen.getByLabelText('Music request') as HTMLInputElement
    act(() => {
      useChatStore.getState().seedAiInput('In measure 5, ', { startMeasureIdx: 4, endMeasureIdx: 4 })
    })
    await act(async () => {
      fireEvent.submit(input.closest('form')!)
    })
    expect(submitSpy).toHaveBeenCalledWith('In measure 5,', {
      targetRegion: { startMeasureIdx: 4, endMeasureIdx: 4 },
    })
  })

  it('does NOT attach the region when the user replaces the seeded text (D5)', async () => {
    render(<PromptBar />)
    const input = screen.getByLabelText('Music request') as HTMLInputElement
    act(() => {
      useChatStore.getState().seedAiInput('In measure 5, ', { startMeasureIdx: 4, endMeasureIdx: 4 })
    })
    // User clears the seed and types an unrelated prompt.
    fireEvent.change(input, { target: { value: 'write a fugue' } })
    await act(async () => {
      fireEvent.submit(input.closest('form')!)
    })
    expect(submitSpy).toHaveBeenCalledWith('write a fugue', undefined)
  })
})

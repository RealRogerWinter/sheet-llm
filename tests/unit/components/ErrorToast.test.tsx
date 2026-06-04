import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ErrorToast from '@/components/ErrorToast'
import { useChatStore } from '@/lib/chat/state'

describe('ErrorToast (M25-PR-2: persist + copyable)', () => {
  beforeEach(() => useChatStore.setState({ error: undefined }))
  afterEach(() => useChatStore.setState({ error: undefined }))

  it('renders nothing when there is no error', () => {
    const { container } = render(<ErrorToast />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the error + a Copy button and does NOT auto-dismiss after 6s', () => {
    vi.useFakeTimers()
    try {
      useChatStore.setState({ error: 'This piece is too large to generate in one pass.' })
      render(<ErrorToast />)
      expect(screen.getByText('This piece is too large to generate in one pass.')).toBeInTheDocument()
      expect(screen.getByLabelText('Copy error message')).toBeInTheDocument()
      // The old behaviour cleared the toast after 6s; advancing well past
      // that must NOT remove it — errors are now copyable indefinitely.
      vi.advanceTimersByTime(10_000)
      expect(screen.getByText('This piece is too large to generate in one pass.')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the dismiss button clears the error', () => {
    useChatStore.setState({ error: 'dismiss me' })
    render(<ErrorToast />)
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText('dismiss me')).not.toBeInTheDocument()
  })

  it('the Copy button writes the error to the clipboard', () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      useChatStore.setState({ error: 'copyable error text' })
      render(<ErrorToast />)
      fireEvent.click(screen.getByLabelText('Copy error message'))
      expect(writeText).toHaveBeenCalledWith('copyable error text')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

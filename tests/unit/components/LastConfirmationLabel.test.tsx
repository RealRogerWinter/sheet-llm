import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import LastConfirmationLabel from '@/components/LastConfirmationLabel'
import { useChatStore } from '@/lib/chat/state'

beforeEach(() => {
  useChatStore.setState({
    abc: undefined,
    introText: undefined,
  })
  cleanup()
})

describe('<LastConfirmationLabel />', () => {
  it('renders nothing when no score is loaded', () => {
    useChatStore.setState({ abc: undefined, introText: 'Changed key to F#' })
    const { container } = render(<LastConfirmationLabel />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when there is no introText', () => {
    useChatStore.setState({ abc: 'X:1\nK:C', introText: undefined })
    const { container } = render(<LastConfirmationLabel />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when introText is an empty string', () => {
    useChatStore.setState({ abc: 'X:1\nK:C', introText: '' })
    const { container } = render(<LastConfirmationLabel />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the confirmation text when both abc and introText are present', () => {
    useChatStore.setState({ abc: 'X:1\nK:C', introText: 'Changed key to F#' })
    render(<LastConfirmationLabel />)
    expect(screen.getByText('Changed key to F#')).toBeInTheDocument()
  })

  it('reflects store updates between renders', () => {
    useChatStore.setState({ abc: 'X:1\nK:C', introText: 'Edited 3 notes' })
    const { rerender } = render(<LastConfirmationLabel />)
    expect(screen.getByText('Edited 3 notes')).toBeInTheDocument()

    useChatStore.setState({ introText: 'Composed “Aubade” — 8 bars in Am' })
    rerender(<LastConfirmationLabel />)
    expect(screen.getByText('Composed “Aubade” — 8 bars in Am')).toBeInTheDocument()
  })
})

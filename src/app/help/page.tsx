import type { Metadata } from 'next'
import HelpContent from './HelpContent'

// Public, indexable docs (unlike /settings). A clear title and
// description help these pages surface in search.
export const metadata: Metadata = {
  title: 'User guide — sheet-llm',
  description:
    'How to compose with the AI, edit notation by hand, use the command palette and keyboard shortcuts, play back, and import or export scores in sheet-llm.',
}

export default function HelpPage() {
  return <HelpContent />
}

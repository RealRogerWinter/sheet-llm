import type { Metadata } from 'next'
import { Suspense } from 'react'
import ResetContent from './ResetContent'

export const metadata: Metadata = {
  title: 'Reset password — sheet-llm',
  robots: { index: false, follow: false },
}

export default function ResetPage() {
  return (
    <Suspense>
      <ResetContent />
    </Suspense>
  )
}

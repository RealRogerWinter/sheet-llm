import type { Metadata } from 'next'
import SettingsContent from './SettingsContent'

// Don't index — settings is per-user and there's no reason for it to
// appear in SERPs. Belt-and-suspenders on top of any robots.txt rules.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: 'Settings — sheet-llm',
}

export default function SettingsPage() {
  return <SettingsContent />
}

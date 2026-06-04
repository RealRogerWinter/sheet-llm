'use client'

import { useEffect } from 'react'
import {
  bootRestoreIfNeeded,
  installBackupInterceptor,
} from '@/lib/auth/clientBackup'

// Install the fetch interceptor at module-import time so every fetch
// from anywhere in the app — including the first one that fires before
// our effect runs — captures the X-Session-Recovery header into
// localStorage. The function is idempotent; double-install is harmless.
//
// Mounted in app/layout.tsx so EVERY route gets this wiring. Earlier
// we ran the install + boot-restore from HomeClient only, which meant
// /settings (and any other route that doesn't mount HomeClient) would
// silently bypass recovery — a cookie-less user hitting /settings
// directly would end up acting against a freshly-minted phantom user.
if (typeof window !== 'undefined') {
  installBackupInterceptor()
}

export default function RecoveryBoot() {
  useEffect(() => {
    void bootRestoreIfNeeded()
  }, [])
  return null
}

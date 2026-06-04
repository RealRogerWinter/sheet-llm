'use client'

import { useSyncExternalStore } from 'react'

/**
 * Module-scoped registry that lets the renderer (ScorePanel) publish
 * the current abcjs visualObj for any subscriber (SynthHost) without
 * routing it through React state — visualObj is too large to diff
 * and mutating it would force unnecessary re-renders.
 *
 * useSyncExternalStore is the right primitive: external mutable
 * data, with a stable subscribe + getSnapshot pair.
 */

type VisualObj = unknown
type Subscriber = () => void

let current: VisualObj | undefined = undefined
const subscribers = new Set<Subscriber>()

export function publishVisualObj(v: VisualObj | undefined): void {
  current = v
  for (const s of subscribers) s()
}

export function getCurrentVisualObj(): VisualObj | undefined {
  return current
}

function subscribe(callback: Subscriber): () => void {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}

function getSnapshot(): VisualObj | undefined {
  return current
}

function getServerSnapshot(): VisualObj | undefined {
  return undefined
}

export function useCurrentVisualObj(): VisualObj | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

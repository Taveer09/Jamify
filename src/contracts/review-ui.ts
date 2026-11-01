import type { Decision, Entry } from './index'
import type { Ref } from 'react'

export type ReviewCardHandle = {
  decide: (uri: string, decision: Decision, animate?: boolean) => void
  cancel: () => boolean
  finish: () => void
}

export type ReviewCardProps = {
  reviewKey?: string
  entry: Entry
  nextEntry?: Entry
  occurrences: number
  canDecide: boolean
  disabled: boolean
  onDecision: (uri: string, decision: Decision) => void
  onPendingChange?: (pending: boolean) => void
  ref?: Ref<ReviewCardHandle>
}
export type ReviewControlsProps = {
  decisionPending?: boolean
  entryUri: string
  canDecide: boolean
  disabled: boolean
  canUndo: boolean
  onDecision: (uri: string, decision: Decision, animate?: boolean) => void
  onUndo: () => void
}

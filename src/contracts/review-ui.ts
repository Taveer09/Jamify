import type { Decision, Entry } from './index'

export type ReviewCardProps = {
  entry: Entry
  occurrences: number
  canDecide: boolean
  disabled: boolean
  onDecision: (uri: string, decision: Decision) => void
}
export type ReviewControlsProps = {
  entryUri: string
  canDecide: boolean
  disabled: boolean
  canUndo: boolean
  onDecision: (uri: string, decision: Decision) => void
  onUndo: () => void
}

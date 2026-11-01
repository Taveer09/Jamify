import type { Ref } from 'react'
import type { Decision, Entry, PlaybackState } from './index'
import type { ReviewCardHandle } from './review-ui'
export type MusicReviewProps = {
  reviewKey?: string
  entry?: Entry; nextEntry?: Entry; occurrences: number; playlistName: string
  cursor: number; total: number; busy: boolean; decisionPending: boolean
  canDecide: boolean; canUndo: boolean; withoutSound: boolean
  playback: PlaybackState; soundLabel: string; canSeek?: boolean
  cardRef: Ref<ReviewCardHandle>
  onPendingChange: (pending: boolean) => void
  onDecisionCommit: (uri: string, decision: Decision) => void
  onDecision: (uri: string, decision: Decision, animate?: boolean) => void
  onUndo: () => void; onTogglePlayback: () => void; onSeek: (position: number) => void
  onSilent: () => void; onFinish: () => void; onBack: () => void
}

import { SpotifyError } from '../spotify/api'
export type PlaybackDiagnostic = {
  stage: 'transfer' | 'state' | 'start' | 'sdk' | 'confirm'
  status: number | null
  reason: string | null
  deviceVisible?: boolean
  deviceRestricted?: boolean
}
export class PlaybackFailure extends Error {
  constructor(readonly diagnostic:PlaybackDiagnostic, readonly reconnect=false) {
    super(diagnostic.stage==='confirm'?'Spotify не подтвердил запуск трека. Нажми «Подключить звук» ещё раз.':diagnostic.status===404?'Spotify не нашёл плеер. Подключи звук ещё раз.':'Не удалось подключить звук Spotify.')
  }
}
export function failureFor(stage:PlaybackDiagnostic['stage'],error:unknown):PlaybackFailure {
  return new PlaybackFailure({stage,status:error instanceof SpotifyError?error.status:null,reason:error instanceof SpotifyError?error.reason:null})
}

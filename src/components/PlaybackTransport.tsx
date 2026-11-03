import type { PlaybackState } from '../contracts'
import type { CSSProperties } from 'react'
import { Button } from './ui/Button'

// Presentation adapted from deltacomponents/MP3 Player, retrieved via 21st.dev MCP.
// https://21st.dev/@deltacomponents/components/mp3-player
// Spotify SDK remains the playback authority; no second Audio element is created.
function time(ms:number) { const seconds=Math.floor(Math.max(0,ms)/1000);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}` }
type Props={playback:PlaybackState;duration:number;canSeek:boolean;blocked:boolean;canPlay:boolean;onTogglePlayback:()=>void;onSeek:(position:number)=>void}
export function PlaybackTransport({playback,duration,canSeek,blocked,canPlay,onTogglePlayback,onSeek}:Props){
 const playing=playback.status==='playing'||playback.status==='loading'
 const position=Math.min(Math.max(0,playback.positionMs),duration)
 const timelineStyle={'--played':`${duration?position/duration*100:0}%`} as CSSProperties
 return (
      <div className="music-player">
        <Button type="button" className="music-play" aria-label={playing ? 'Пауза' : 'Слушать'} disabled={blocked || !canPlay} onClick={onTogglePlayback}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{playing ? <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></> : <path d="M8 4.8c0-.8.9-1.3 1.6-.9l11 7.2c.6.4.6 1.4 0 1.8l-11 7.2c-.7.4-1.6-.1-1.6-.9z" />}</svg>
        </Button>
        <div className="music-timeline" style={timelineStyle}>
          <span className="transport-time">{time(position)}</span>
          {canSeek ? <div className="music-seek"><span className="music-seek-track" aria-hidden="true"><span /></span><input type="range" aria-label="Позиция воспроизведения" aria-valuetext={`${time(position)} из ${time(duration)}`} step="1000" min="0" max={Math.max(1, duration)} value={position} disabled={blocked || !canPlay || !duration || playback.status === 'loading'} onChange={(event) => onSeek(Number(event.target.value))} /></div> : <div className="music-progress"><progress aria-label="Позиция воспроизведения" aria-valuetext={`${time(position)} из ${time(duration)}`} max={Math.max(1, duration)} value={position} /></div>}
          <span className="transport-time">{time(duration)}</span>
        </div>
      </div>
 )
}

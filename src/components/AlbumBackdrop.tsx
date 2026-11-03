import { memo, useEffect, useRef, useState } from 'react'

const fadeMs = 520
type Layers = { images: [string | null, string | null]; active: -1 | 0 | 1 }

/** Two bounded layers: decode first, then blend. Rapid choices retain only the newest request. */
export const AlbumBackdrop = memo(function AlbumBackdrop({ imageUrl }: { imageUrl?: string | null }) {
  const [layers, setLayers] = useState<Layers>({ images: [null, null], active: -1 })
  const current = useRef(layers)
  const availableAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const show = (url: string | null) => {
      clearTimeout(timer.current)
      // Never replace a layer while it is still visible during a preceding blend.
      timer.current = setTimeout(() => {
        if (cancelled) return
        const previous = current.current
        if (url === (previous.active === -1 ? null : previous.images[previous.active])) return
        const active = url ? (previous.active === 0 ? 1 : 0) : -1
        const images: Layers['images'] = [...previous.images]
        if (active !== -1) images[active] = url
        current.current = { images, active }
        setLayers(current.current)
        availableAt.current = Date.now() + (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : fadeMs)
      }, Math.max(0, availableAt.current - Date.now()))
    }
    const image = new Image()
    image.onload = () => {
      void image.decode().catch(() => {}).then(() => { if (!cancelled) show(imageUrl ?? null) })
    }
    image.onerror = () => { if (!cancelled) show(null) }
    if (imageUrl) image.src = imageUrl
    else show(null)
    return () => {
      cancelled = true
      clearTimeout(timer.current)
      image.onload = image.onerror = null
    }
  }, [imageUrl])

  return <div className="album-backdrop" aria-hidden="true">
    {layers.images.map((url, index) => <div key={index} className={`album-backdrop-layer${layers.active === index ? ' is-current' : ''}`}>
      {url && <img src={url} alt="" decoding="async" draggable="false" />}
    </div>)}
    <div className="album-backdrop-scrim" />
  </div>
})

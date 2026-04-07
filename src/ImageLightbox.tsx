import { useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { ProjectImage } from './types'

interface ImageLightboxProps {
  images: ProjectImage[]
  currentIndex: number
  onClose: () => void
  onNavigate: (index: number) => void
}

export default function ImageLightbox({ images, currentIndex, onClose, onNavigate }: ImageLightboxProps) {
  const image = images[currentIndex]
  if (!image) return null

  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'ArrowLeft' && hasPrev) onNavigate(currentIndex - 1)
    if (e.key === 'ArrowRight' && hasNext) onNavigate(currentIndex + 1)
  }, [onClose, onNavigate, currentIndex, hasPrev, hasNext])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [handleKeyDown])

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose}><X size={20} /></button>
      {hasPrev && (
        <button className="lightbox-nav lightbox-prev" onClick={e => { e.stopPropagation(); onNavigate(currentIndex - 1) }}>
          <ChevronLeft size={28} />
        </button>
      )}
      <div className="lightbox-content" onClick={e => e.stopPropagation()}>
        <img src={`/api/images/${image.id}`} alt={image.caption || image.original_name} />
        {image.caption && <div className="lightbox-caption">{image.caption}</div>}
        {images.length > 1 && (
          <div className="lightbox-counter">{currentIndex + 1} / {images.length}</div>
        )}
      </div>
      {hasNext && (
        <button className="lightbox-nav lightbox-next" onClick={e => { e.stopPropagation(); onNavigate(currentIndex + 1) }}>
          <ChevronRight size={28} />
        </button>
      )}
    </div>
  )
}

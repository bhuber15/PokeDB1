'use client'
import { useState } from 'react'
import { CatalogueBrowser, type CatalogueSelection } from '@/components/catalogue/CatalogueBrowser'
import { CardZoomModal, type CardZoomData } from '@/components/shared/CardZoomModal'

export default function CataloguePage() {
  const [zoomed, setZoomed] = useState<CardZoomData | null>(null)

  function handleSelect({ card, prices }: CatalogueSelection) {
    setZoomed({
      name: card.name,
      setName: card.setName,
      setNumber: card.setNumber,
      variant: card.variant,
      imageUrlLarge: card.imageUrlLarge,
      imageUrl: card.imageUrl,
      tcgplayerMarket: prices?.tcgplayerMarket ?? null,
      cardmarketTrend: prices?.cardmarketTrend ?? null,
    })
  }

  return (
    <div style={{ height: 'calc(100vh - 120px)' }}>
      <CardZoomModal card={zoomed} onClose={() => setZoomed(null)} />
      <CatalogueBrowser onSelectCard={handleSelect} />
    </div>
  )
}

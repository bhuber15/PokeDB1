'use client'
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SearchBarProps {
  onSearch: (query: string) => void
  onQRDetected: (code: string) => void
  loading?: boolean
}

export function SearchBar({ onSearch, onQRDetected, loading }: SearchBarProps) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { ref.current?.focus() }, [])

  // "/" from anywhere on the page jumps to search (unless already typing)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      e.preventDefault()
      ref.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Refocus after a search completes so scan → add → scan flows hands-free
  useEffect(() => {
    if (!loading) ref.current?.focus()
  }, [loading])

  function submit() {
    const q = value.trim()
    if (!q) return
    setValue('')
    if (UUID_PATTERN.test(q)) {
      onQRDetected(q)
    } else {
      onSearch(q)
    }
  }

  return (
    <div className="flex gap-2">
      <Input
        ref={ref}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="Scan barcode / QR label or type a name…"
        aria-label="Search inventory or scan a barcode"
        className="h-12 text-base"
        disabled={loading}
      />
      <Button className="h-12 px-6" onClick={submit} disabled={loading || !value.trim()}>
        Search
      </Button>
    </div>
  )
}

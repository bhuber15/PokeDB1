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
        placeholder="Scan QR label or type card name / set number…"
        className="h-12 text-base"
        disabled={loading}
      />
      <Button className="h-12 px-6" onClick={submit} disabled={loading || !value.trim()}>
        Search
      </Button>
    </div>
  )
}

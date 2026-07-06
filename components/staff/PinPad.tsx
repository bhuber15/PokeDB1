'use client'
import { useState } from 'react'
import { DeleteIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PinPadProps {
  onSubmit: (pin: string) => void
  error?: string
  loading?: boolean
  disabled?: boolean
}

export function PinPad({ onSubmit, error, loading, disabled }: PinPadProps) {
  const [pin, setPin] = useState('')

  function handleDigit(digit: string) {
    if (pin.length >= 4) return
    const next = pin + digit
    setPin(next)
    if (next.length === 4) {
      onSubmit(next)
      setTimeout(() => setPin(''), 600)
    }
  }

  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex gap-3">
        {[0,1,2,3].map(i => (
          <div
            key={i}
            className={`w-4 h-4 rounded-full border-2 transition-colors ${pin.length > i ? 'bg-foreground border-foreground' : 'border-muted-foreground'}`}
          />
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid grid-cols-3 gap-3">
        {keys.map((key, i) => key === '' ? (
          // Empty grid slot — decorative, not a control
          <div key={i} className="w-16 h-16" aria-hidden="true" />
        ) : (
          <Button
            key={i}
            variant="outline"
            className="w-16 h-16 text-xl"
            disabled={loading || disabled}
            onClick={() => key === '⌫' ? setPin(p => p.slice(0, -1)) : handleDigit(key)}
            aria-label={key === '⌫' ? 'Delete digit' : `Digit ${key}`}
          >
            {key === '⌫' ? <DeleteIcon className="size-5" aria-hidden="true" /> : key}
          </Button>
        ))}
      </div>
    </div>
  )
}

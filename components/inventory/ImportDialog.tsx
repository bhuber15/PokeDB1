'use client'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const TEMPLATE_HEADER = 'external_id,name,set_name,set_number,condition,quantity,cost_price,sell_price_override,location,defect_notes'
const TEMPLATE_EXAMPLE = 'base1-4,Charizard,Base Set,4/102,NM,1,150.00,,Binder A,'
const TEMPLATE_CSV = `${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE}\n`
const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`

interface ImportError {
  row: number
  message: string
}

interface ImportDialogProps {
  open: boolean
  onClose: () => void
  onDone: () => void
}

export function ImportDialog({ open, onClose, onDone }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<ImportError[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  function reset() {
    setFile(null)
    setErrors([])
    setLoading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleImport() {
    if (!file) return
    setLoading(true)
    setErrors([])
    try {
      const text = await file.text()
      const res = await fetch('/api/inventory/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text,
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Import failed')
        setLoading(false)
        return
      }
      const { created, errors: rowErrors } = data as { created: number; errors: ImportError[] }
      toast.success(`Imported ${created} items`)
      setErrors(rowErrors ?? [])
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      onDone()
    } catch {
      toast.error('Import failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogTitle>Import Inventory CSV</DialogTitle>
        <div className="space-y-4">
          <a
            href={templateHref}
            download="inventory-template.csv"
            className="text-sm text-primary underline underline-offset-4"
          >
            Download template
          </a>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="text-sm"
            />
          </div>
          {errors.length > 0 && (
            <div className="border rounded-lg divide-y text-sm max-h-48 overflow-y-auto">
              {errors.map((e, i) => (
                <div key={i} className="flex justify-between gap-2 p-2">
                  <span className="text-muted-foreground">Row {e.row}</span>
                  <span className="text-destructive">{e.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={loading}>Cancel</Button>
          <Button onClick={handleImport} disabled={!file || loading} className="flex-1">
            {loading ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

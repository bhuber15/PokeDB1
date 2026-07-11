'use client'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'

type Role = 'admin' | 'staff'
interface StaffMember {
  id: number
  name: string
  role: Role
  isActive: boolean
}

const PIN_RE = /^\d{4}$/

export function StaffSection() {
  const [members, setMembers] = useState<StaffMember[] | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [pinFor, setPinFor] = useState<StaffMember | null>(null)

  // Refresh the list after a mutation. Only ever called from event handlers /
  // child callbacks, so setState here is outside any effect.
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/staff')
      if (!res.ok) throw new Error()
      setMembers(await res.json())
    } catch {
      toast.error('Could not load staff')
    }
  }, [])

  useEffect(() => {
    fetch('/api/staff')
      .then(async res => {
        if (!res.ok) throw new Error()
        setMembers(await res.json())
      })
      .catch(() => toast.error('Could not load staff'))
  }, [])

  // Applies a PATCH and refreshes; surfaces the domain error message (e.g. the
  // last-active-admin guard) so the user learns why an action was refused.
  async function patch(member: StaffMember, body: Record<string, unknown>) {
    setBusyId(member.id)
    try {
      const res = await fetch(`/api/staff/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Update failed')
        return false
      }
      await load()
      return true
    } catch {
      toast.error('Could not reach the server')
      return false
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Staff</h2>
        <Button size="sm" onClick={() => setAddOpen(true)}>Add staff</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Staff sign in with a 4-digit PIN. Admins can manage staff, settings and reports.
        Departed staff are deactivated (their PIN stops working) rather than deleted, so past
        sales stay attributed.
      </p>

      {members === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No staff yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {members.map(m => (
            <li key={m.id} className="flex items-center gap-2 py-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`font-medium truncate ${m.isActive ? '' : 'text-muted-foreground line-through'}`}>{m.name}</span>
                  <Badge variant={m.role === 'admin' ? 'default' : 'secondary'}>{m.role}</Badge>
                  {!m.isActive && <Badge variant="outline">inactive</Badge>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline" size="sm" disabled={busyId === m.id}
                  onClick={() => patch(m, { role: m.role === 'admin' ? 'staff' : 'admin' })}
                >
                  {m.role === 'admin' ? 'Make staff' : 'Make admin'}
                </Button>
                <Button variant="outline" size="sm" disabled={busyId === m.id} onClick={() => setPinFor(m)}>
                  Reset PIN
                </Button>
                <Button
                  variant={m.isActive ? 'destructive' : 'outline'} size="sm" disabled={busyId === m.id}
                  onClick={() => patch(m, { isActive: !m.isActive })}
                >
                  {m.isActive ? 'Deactivate' : 'Reactivate'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddStaffDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />
      <ResetPinDialog member={pinFor} onClose={() => setPinFor(null)} />
    </section>
  )
}

function AddStaffDialog({
  open, onOpenChange, onAdded,
}: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [saving, setSaving] = useState(false)

  function reset() { setName(''); setPin(''); setRole('staff') }

  async function submit() {
    if (!name.trim()) { toast.error('Name is required'); return }
    if (!PIN_RE.test(pin)) { toast.error('PIN must be 4 digits'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), pin, role }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not add staff')
        return
      }
      toast.success(`Added ${name.trim()}`)
      reset()
      onOpenChange(false)
      onAdded()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add staff member</DialogTitle>
          <DialogDescription>They&apos;ll sign in at the till with this PIN.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="add-staff-name">Name</Label>
            <Input id="add-staff-name" value={name} onChange={e => setName(e.target.value)} maxLength={60} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-staff-pin">4-digit PIN</Label>
            <Input
              id="add-staff-pin" inputMode="numeric" maxLength={4} value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="e.g. 4821"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <RoleToggle value={role} onChange={setRole} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Adding…' : 'Add staff'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResetPinDialog({ member, onClose }: { member: StaffMember | null; onClose: () => void }) {
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!member) return
    if (!PIN_RE.test(pin)) { toast.error('PIN must be 4 digits'); return }
    setSaving(true)
    try {
      const res = await fetch(`/api/staff/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not reset PIN')
        return
      }
      toast.success(`PIN reset for ${member.name}`)
      setPin('')
      onClose()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!member} onOpenChange={v => { if (!v) { setPin(''); onClose() } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset PIN{member ? ` — ${member.name}` : ''}</DialogTitle>
          <DialogDescription>Enter a new 4-digit PIN. The old one stops working immediately.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reset-pin">New 4-digit PIN</Label>
          <Input
            id="reset-pin" inputMode="numeric" maxLength={4} value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="e.g. 4821" autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Reset PIN'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RoleToggle({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <div className="flex gap-2">
      {(['staff', 'admin'] as const).map(r => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium capitalize transition-colors ${
            value === r ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  )
}

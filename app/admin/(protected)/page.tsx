import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { tenantOverview } from '@/lib/platform/overview'
import { tenantUrl } from '@/lib/platform/tenants'
import { ImpersonateButton } from '@/components/admin/ImpersonateButton'

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default', trialing: 'secondary', past_due: 'destructive',
  suspended: 'destructive', cancelled: 'outline', paused: 'outline',
}

function formatWhen(dt: string | null): string {
  if (!dt) return '—'
  const d = new Date(dt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return dt
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export default async function AdminTenantsPage() {
  const rows = await tenantOverview()
  const baseHost = process.env.PLATFORM_BASE_HOST!
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.tenant.status] = (acc[r.tenant.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Tenants ({rows.length})</h1>
        {Object.entries(counts).map(([status, n]) => (
          <Badge key={status} variant={STATUS_VARIANT[status] ?? 'outline'}>{status}: {n}</Badge>
        ))}
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shop</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Signed up</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>DB</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ tenant, lastActivityAt, reachable }) => (
              <TableRow key={tenant.id}>
                <TableCell>
                  <a className="hover:underline" href={tenantUrl(tenant.slug, baseHost)} target="_blank" rel="noreferrer">
                    <span className="font-medium">{tenant.name}</span>{' '}
                    <span className="text-muted-foreground">{tenant.slug}</span>
                  </a>
                </TableCell>
                <TableCell className="capitalize">{tenant.plan}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[tenant.status] ?? 'outline'}>{tenant.status}</Badge>
                </TableCell>
                <TableCell>{new Date(tenant.createdAt * 1000).toLocaleDateString('en-GB')}</TableCell>
                <TableCell>{formatWhen(lastActivityAt)}</TableCell>
                <TableCell>
                  {reachable
                    ? <span className="text-muted-foreground">ok</span>
                    : <Badge variant="destructive">unreachable</Badge>}
                </TableCell>
                <TableCell>
                  {tenant.stripeCustomerId
                    ? <a className="hover:underline" href={`https://dashboard.stripe.com/customers/${tenant.stripeCustomerId}`} target="_blank" rel="noreferrer">Stripe ↗</a>
                    : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell><ImpersonateButton tenantId={tenant.id} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-sm text-muted-foreground">
        Activity and reachability are probed live from each tenant DB and cached for 5 minutes.
      </p>
    </div>
  )
}

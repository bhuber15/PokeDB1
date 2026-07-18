import { desc, inArray } from 'drizzle-orm'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getPlatformDb } from '@/lib/platform/db'
import { platformAudit, tenants } from '@/lib/platform/schema'

export default async function AdminAuditPage() {
  const pdb = getPlatformDb()
  const rows = await pdb.select().from(platformAudit).orderBy(desc(platformAudit.id)).limit(200)
  const tenantIds = [...new Set(rows.map(r => r.tenantId).filter((x): x is number => x != null))]
  const slugById = new Map(
    tenantIds.length
      ? (await pdb.select().from(tenants).where(inArray(tenants.id, tenantIds))).map(t => [t.id, t.slug])
      : [],
  )
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Audit trail</h1>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When (UTC)</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{new Date(r.createdAt * 1000).toISOString().replace('T', ' ').slice(0, 19)}</TableCell>
                <TableCell>{r.actor}</TableCell>
                <TableCell>{r.action}</TableCell>
                <TableCell>{r.tenantId != null ? (slugById.get(r.tenantId) ?? r.tenantId) : '—'}</TableCell>
                <TableCell className="text-muted-foreground">{r.detail ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

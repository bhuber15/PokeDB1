import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getEntitlements } from '@/lib/entitlements'
import { SettingsForm } from '@/components/settings/SettingsForm'
import { StaffSection } from '@/components/settings/StaffSection'
import { BillingCard } from '@/components/settings/BillingCard'
import { DataExportCard } from '@/components/settings/DataExportCard'

export default async function SettingsPage() {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) redirect('/pos')
  const ent = await getEntitlements()
  return (
    <div className="max-w-lg space-y-6">
      <SettingsForm multiGame={ent.multiGame} />
      <StaffSection />
      {process.env.TENANCY_MODE === 'multi' && <BillingCard />}
      <DataExportCard />
    </div>
  )
}

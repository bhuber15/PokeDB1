import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { SettingsForm } from '@/components/settings/SettingsForm'
import { StaffSection } from '@/components/settings/StaffSection'

export default async function SettingsPage() {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) redirect('/pos')
  return (
    <div className="max-w-lg space-y-6">
      <SettingsForm />
      <StaffSection />
    </div>
  )
}

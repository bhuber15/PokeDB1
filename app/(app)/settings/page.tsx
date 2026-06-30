import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { SettingsForm } from '@/components/settings/SettingsForm'

export default async function SettingsPage() {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) redirect('/pos')
  return <SettingsForm />
}

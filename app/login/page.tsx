import { getTenantDb } from '@/lib/db'
import { getSettings } from '@/lib/settings'
import { LoginForm } from '@/components/auth/LoginForm'

export default async function LoginPage() {
  const { shopName } = await getSettings(await getTenantDb())
  return <LoginForm shopName={shopName} />
}

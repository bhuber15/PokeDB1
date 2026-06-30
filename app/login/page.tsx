import { getSettings } from '@/lib/settings'
import { LoginForm } from '@/components/auth/LoginForm'

export default async function LoginPage() {
  const { shopName } = await getSettings()
  return <LoginForm shopName={shopName} />
}

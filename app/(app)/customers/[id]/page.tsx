import { CustomerDetail } from '@/components/customers/CustomerDetail'

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <CustomerDetail id={Number(id)} />
}

import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function DataExportCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data export</CardTitle>
        <CardDescription>
          Download everything — one CSV per table plus a manifest. This is the full
          GDPR/offboarding export; inventory and sales also have focused exports on their pages.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <a href="/api/settings/full-export" download className={cn(buttonVariants({ variant: 'outline' }))}>
          Download full export
        </a>
      </CardContent>
    </Card>
  )
}

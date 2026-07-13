import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { getOnboarding, markOnboardingStep, dismissOnboarding } from '@/lib/domain/onboarding'

const onboardingBody = z.object({
  step: z.literal('settings').optional(),
  dismiss: z.boolean().optional(),
})

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  return NextResponse.json(await getOnboarding(db))
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const { step, dismiss } = await parseBody(req, onboardingBody)
  if (step) await markOnboardingStep(step, db)
  if (dismiss) await dismissOnboarding(db)
  return NextResponse.json(await getOnboarding(db))
})

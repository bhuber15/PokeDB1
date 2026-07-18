'use client'

import { useEffect } from 'react'

declare global {
  interface Window { $crisp?: unknown[]; CRISP_WEBSITE_ID?: string }
}

// Support chat (spec §3.9), env-gated: no NEXT_PUBLIC_CRISP_WEBSITE_ID → no
// script, no widget, nothing rendered.
export function CrispChat() {
  useEffect(() => {
    const id = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID
    if (!id || document.getElementById('crisp-chat')) return
    window.$crisp = window.$crisp ?? []
    window.CRISP_WEBSITE_ID = id
    const script = document.createElement('script')
    script.id = 'crisp-chat'
    script.src = 'https://client.crisp.chat/l.js'
    script.async = true
    document.head.appendChild(script)
  }, [])
  return null
}

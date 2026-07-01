export default function Loading() {
  return (
    <div className="flex items-center justify-center py-24 text-muted-foreground" role="status" aria-live="polite">
      <div className="size-6 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
      <span className="sr-only">Loading…</span>
    </div>
  )
}

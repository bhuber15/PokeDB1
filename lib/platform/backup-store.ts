// Where backup dumps live. Vercel Blob in production (spec §3.9), an
// in-memory map in tests. Feature-gated: no BLOB_READ_WRITE_TOKEN → no store
// → the backup cron no-ops green.

export interface BackupObject { key: string; url: string; uploadedAt: number }  // epoch seconds

export interface BackupStore {
  put(key: string, data: Uint8Array): Promise<void>
  list(prefix: string): Promise<BackupObject[]>
  del(urls: string[]): Promise<void>
}

export function getBackupStore(): BackupStore | null {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null
  return {
    async put(key, data) {
      const { put } = await import('@vercel/blob')
      // Backups are shop data — never on public URLs.
      await put(key, Buffer.from(data), {
        access: 'private', addRandomSuffix: false, contentType: 'application/gzip',
      })
    },
    async list(prefix) {
      const { list } = await import('@vercel/blob')
      const out: BackupObject[] = []
      let cursor: string | undefined
      do {
        const page = await list({ prefix, cursor, limit: 1000 })
        for (const b of page.blobs) {
          out.push({ key: b.pathname, url: b.url, uploadedAt: Math.floor(new Date(b.uploadedAt).getTime() / 1000) })
        }
        cursor = page.hasMore ? page.cursor : undefined
      } while (cursor)
      return out
    },
    async del(urls) {
      if (urls.length === 0) return
      const { del } = await import('@vercel/blob')
      await del(urls)
    },
  }
}

export function memoryBackupStore(): BackupStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    async put(key, data) { objects.set(key, data) },
    async list(prefix) {
      return [...objects.keys()].filter(k => k.startsWith(prefix))
        .map(k => ({ key: k, url: k, uploadedAt: 0 }))
    },
    async del(urls) { for (const u of urls) objects.delete(u) },
  }
}

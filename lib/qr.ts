import QRCode from 'qrcode'
import { randomUUID } from 'crypto'

export function generateQRId(): string {
  return randomUUID()
}

export async function generateQRDataURL(qrCode: string): Promise<string> {
  return QRCode.toDataURL(qrCode, { width: 200, margin: 1 })
}

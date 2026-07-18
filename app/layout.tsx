import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { CrispChat } from "@/components/shared/CrispChat";
import { BRAND } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: BRAND.productName,
  description: "Point of sale, inventory and pricing for a collectible card shop.",
};

// Permanently dark UI: colorScheme fixes native controls/scrollbars; themeColor tints mobile browser chrome to match the app background.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0d15",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {/* App is permanently dark; force the toast theme to match instead of relying on next-themes context. */}
        <Toaster theme="dark" />
        <CrispChat />
      </body>
    </html>
  );
}

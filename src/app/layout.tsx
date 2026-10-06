import type { Metadata, Viewport } from "next";
import { Fraunces, Geist_Mono, Outfit } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Excursion — Leader",
  description:
    "Leader beacon dashboard for the Guided Excursion Wearable. Distance, direction, battery, and check-ins without cell service.",
  applicationName: "Excursion",
  appleWebApp: {
    capable: true,
    title: "Excursion",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#234037",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${fraunces.variable} ${mono.variable}`}
      // The phone preview stamps __gcrremoteframetoken on <html> before React hydrates.
      // Without this, that extra attribute aborts the whole page.
      suppressHydrationWarning
    >
      <body className="antialiased" suppressHydrationWarning>
        {children}
        <Toaster position="top-center" />
      </body>
    </html>
  );
}

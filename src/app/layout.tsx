import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import RecoveryBoot from "@/components/RecoveryBoot";
import TurnstileGate from "@/components/TurnstileGate";
import "./globals.css";
import "abcjs/abcjs-audio.css";
import "@/styles/abcjs-overlay.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "sheet-llm",
  description: "Sheet music generating chatbot powered by Claude",
};

// `viewportFit: 'cover'` is the prerequisite for non-zero env(safe-area-inset-*)
// on notched devices; the editor's own pinch-zoom handles score magnification,
// but page user-scaling is intentionally left enabled for accessibility (no
// maximumScale/userScalable lock). themeColor matches --paper in each scheme so
// the mobile browser chrome blends with the page.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

// Runs synchronously in <head> before first paint to set data-theme on
// <html>, preventing a light-to-dark flash on load for dark-mode users.
// Picks stored preference if present, otherwise follows the OS setting.
const themeBootstrap = `(function(){try{var s=localStorage.getItem('sheet-llm:theme');var t=s==='dark'||s==='light'?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <RecoveryBoot />
        <TurnstileGate />
        {children}
      </body>
    </html>
  );
}

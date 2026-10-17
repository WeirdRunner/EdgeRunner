import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "EdgeRunner",
  description: "High-performance edge AI inference and agent terminal.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <head>
        {/* Cross-origin isolation for the in-browser workspace (WebContainers) on hosts that can't set headers,
            e.g. GitHub Pages. No-op when the server already sends COOP/COEP (next dev does, see next.config). */}
        <script dangerouslySetInnerHTML={{ __html: "window.coi = { coepCredentialless: function () { return true; }, quiet: true };" }} />
        <script src={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/coi-serviceworker.js`} />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener('unhandledrejection', function(event) {
                var r = event.reason;
                if (r === 'Canceled' || (r && (r.message === 'Canceled' || r.name === 'Canceled' || r.type === 'cancel' || String(r).indexOf('Canceled') !== -1))) {
                  event.preventDefault();
                  event.stopImmediatePropagation();
                }
              });
            `,
          }}
        />
      </head>
      <body className="font-mono bg-term-bg text-term-fg antialiased selection:bg-term-green/20 selection:text-term-green">
        {children}
      </body>
    </html>
  );
}

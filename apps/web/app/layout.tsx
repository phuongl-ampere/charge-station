import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Charge Station",
  description: "Local EV charging checkout and live station status",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-frame">
          <header className="topbar">
            <a className="brand" href="/" aria-label="Charge Station home">
              <span className="brand-mark" aria-hidden="true">
                +
              </span>
              <span>Charge Station</span>
            </a>
            <span className="local-badge">Local network</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}

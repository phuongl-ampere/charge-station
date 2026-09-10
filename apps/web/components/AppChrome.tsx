"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) {
    return <>{children}</>;
  }

  return (
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
  );
}

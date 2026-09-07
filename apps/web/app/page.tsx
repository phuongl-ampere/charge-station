"use client";

import { ArrowRight, ScanLine } from "lucide-react";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  const [connectorCode, setConnectorCode] = useState("");

  function openConnector(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const code = connectorCode.trim().toUpperCase();
    if (code) router.push(`/scan/${encodeURIComponent(code)}`);
  }

  return (
    <main className="access-shell">
      <section className="access-instrument" aria-labelledby="access-heading">
        <div className="access-glyph" aria-hidden="true">
          <ScanLine size={32} />
        </div>
        <p className="eyebrow">Charger access</p>
        <h1 id="access-heading">Enter connector code</h1>
        <form onSubmit={openConnector}>
          <label htmlFor="connector-code">Connector</label>
          <div className="connector-entry">
            <input
              id="connector-code"
              value={connectorCode}
              onChange={(event) => setConnectorCode(event.target.value)}
              placeholder="ST01-C01"
              autoCapitalize="characters"
              autoComplete="off"
              required
            />
            <button
              className="icon-button"
              type="submit"
              aria-label="Open connector"
              title="Open connector"
            >
              <ArrowRight size={18} />
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

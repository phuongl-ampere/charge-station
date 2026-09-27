import { ScanLine } from "lucide-react";

export default function HomePage() {
  return (
    <main className="access-shell">
      <section className="access-instrument" aria-labelledby="access-heading">
        <div className="access-glyph" aria-hidden="true">
          <ScanLine size={32} />
        </div>
        <p className="eyebrow">Charger access</p>
        <h1 id="access-heading">Scan your station QR</h1>
        <p>
          Use the encrypted station QR issued by an operator to choose an
          available connector. Connector codes are never accepted in public URLs.
        </p>
      </section>
    </main>
  );
}

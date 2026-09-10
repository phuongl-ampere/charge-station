"use client";

import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

import { adminApi, type AdminApi } from "../lib/api";

type AdminLoginProps = {
  api?: Pick<AdminApi, "login">;
  onAuthenticated: (accessToken: string) => void;
};

export function AdminLogin({
  api = adminApi,
  onAuthenticated,
}: AdminLoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.login({ email: email.trim(), password });
      onAuthenticated(result.accessToken);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to sign in",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="admin-login-shell">
      <section className="admin-login-panel" aria-labelledby="admin-login-title">
        <div className="admin-login-symbol" aria-hidden="true">
          <ShieldCheck size={30} />
        </div>
        <p className="eyebrow">Charge station operations</p>
        <h1 id="admin-login-title">Operator sign in</h1>
        <p className="admin-login-copy">
          Access station status, sessions, payments, and device activity.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="admin-email">Email</label>
          <input
            autoComplete="username"
            id="admin-email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
          <label htmlFor="admin-password">Password</label>
          <input
            autoComplete="current-password"
            id="admin-password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          {error ? (
            <p className="admin-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="admin-login-button" disabled={submitting} type="submit">
            {submitting ? (
              <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
            ) : (
              <KeyRound size={17} aria-hidden="true" />
            )}
            Sign in
          </button>
        </form>
      </section>
    </main>
  );
}

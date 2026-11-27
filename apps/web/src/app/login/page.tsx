"use client";

import { type FormEvent, useState } from "react";
import { login } from "@/lib/api";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
      window.location.assign("/");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not sign in.");
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero login">
        <p className="eyebrow">Cloud Deploy</p>
        <h1>Sign in</h1>
        <form className="card form" onSubmit={onSubmit}>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

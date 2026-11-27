"use client";

import { useEffect, useState } from "react";
import { getSession, logout } from "@/lib/api";

/** "Sign out" in the corner, shown only when login is on and the user is signed in. */
export function SignOut() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    getSession()
      .then((session) => setVisible(session.required && session.signedIn))
      .catch(() => setVisible(false));
  }, []);

  if (!visible) return null;
  return (
    <button
      type="button"
      className="button-quiet sign-out"
      onClick={async () => {
        await logout().catch(() => undefined);
        window.location.assign("/login");
      }}
    >
      Sign out
    </button>
  );
}

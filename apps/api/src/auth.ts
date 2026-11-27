import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type RequestHandler, type Router } from "express";

/**
 * Single-admin login. The password comes from configuration; a signed,
 * HTTP-only cookie keeps the session. Without a password, login is off
 * (local development).
 */
export interface AuthOptions {
  password: string;
  /** Signs session cookies. Random per process when not given. */
  secret?: string;
  /** Mark the cookie Secure (served over HTTPS). */
  secureCookie: boolean;
  sessionHours?: number;
  /** Failed attempts allowed per address per window. */
  maxFailures?: number;
  windowMs?: number;
}

export const SESSION_COOKIE = "cp_session";
const PUBLIC_PATHS = ["/health/live", "/health/ready", "/auth/login", "/auth/session"];

const digest = (value: string) => createHash("sha256").update(value).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function createAuth(options: AuthOptions): { router: Router; guard: RequestHandler } {
  const secret = options.secret || randomBytes(32).toString("hex");
  const sessionMs = (options.sessionHours ?? 12) * 3_600_000;
  const maxFailures = options.maxFailures ?? 5;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const failures = new Map<string, { count: number; until: number }>();

  const sign = (expires: number) =>
    `${expires}.${createHmac("sha256", secret).update(String(expires)).digest("base64url")}`;
  const valid = (token: string | null) => {
    if (!token) return false;
    const [expires] = token.split(".");
    return Number(expires) > Date.now() && sameSecret(token, sign(Number(expires)));
  };
  const signedIn = (cookieHeader: string | undefined) =>
    !options.password || valid(readCookie(cookieHeader, SESSION_COOKIE));
  const cookie = (value: string, maxAgeMs: number) =>
    [
      `${SESSION_COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      ...(options.secureCookie ? ["Secure"] : []),
    ].join("; ");

  const router = express.Router();

  router.get("/auth/session", (request, response) => {
    response.json({
      required: Boolean(options.password),
      signedIn: signedIn(request.headers.cookie),
    });
  });

  router.post("/auth/login", (request, response) => {
    const address = request.ip ?? "unknown";
    const now = Date.now();
    const entry = failures.get(address);
    if (entry && entry.until > now && entry.count >= maxFailures) {
      response.status(429).json({
        error: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts. Try again later." },
      });
      return;
    }
    const password: unknown = request.body?.password;
    if (
      !options.password ||
      typeof password !== "string" ||
      !sameSecret(password, options.password)
    ) {
      const fresh = !entry || entry.until <= now;
      failures.set(address, {
        count: fresh ? 1 : entry.count + 1,
        until: fresh ? now + windowMs : entry.until,
      });
      response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Wrong password." } });
      return;
    }
    failures.delete(address);
    response.setHeader("set-cookie", cookie(sign(now + sessionMs), sessionMs));
    response.json({ required: true, signedIn: true });
  });

  router.post("/auth/logout", (_request, response) => {
    response.setHeader("set-cookie", cookie("", 0));
    response.json({ required: Boolean(options.password), signedIn: false });
  });

  const guard: RequestHandler = (request, response, next) => {
    if (PUBLIC_PATHS.includes(request.path) || signedIn(request.headers.cookie)) return next();
    response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in first." } });
  };

  return { router, guard };
}

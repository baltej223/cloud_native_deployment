import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { FakeRouter, FakeRuntime } from "@cloud-platform/drivers/testing";
import { createLogger } from "@cloud-platform/platform";
import { InMemoryProjectRepository } from "@cloud-platform/platform/testing";
import { createApp } from "./app.js";
import { ProjectsService } from "./projects-service.js";

const logger = createLogger("auth-test", "silent");
let baseUrl = "";
let close: () => void;

before(async () => {
  const app = createApp({
    projects: new ProjectsService(
      new InMemoryProjectRepository(),
      new FakeRouter(),
      new FakeRuntime(),
      { portRange: { min: 8001, max: 8010 }, maxProjects: 10 },
      logger,
    ),
    logger,
    allowedOrigins: [],
    readinessChecks: {},
    auth: { password: "correct horse", secureCookie: true, maxFailures: 3 },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const login = (password: string) =>
  fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });

test("requests need a session; health checks do not", async () => {
  assert.equal((await fetch(`${baseUrl}/projects`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/health/live`)).status, 200);
  const session = await (await fetch(`${baseUrl}/auth/session`)).json();
  assert.deepEqual(session, { required: true, signedIn: false });
});

test("the right password gives a secure session cookie", async () => {
  const response = await login("correct horse");
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const value = cookie.split(";")[0]!;
  assert.equal((await fetch(`${baseUrl}/projects`, { headers: { cookie: value } })).status, 200);

  // A tampered cookie is refused.
  const forged = value.replace(/\.(.)/, (_match, c: string) => `.${c === "A" ? "B" : "A"}`);
  assert.equal((await fetch(`${baseUrl}/projects`, { headers: { cookie: forged } })).status, 401);
});

test("wrong passwords are refused and then rate limited", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await login("nope")).status, 401);
  assert.equal((await login("correct horse")).status, 429);
});

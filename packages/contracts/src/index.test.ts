import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canTransition,
  createProjectRequestSchema,
  IMAGE_REFERENCE_PATTERN,
  normalizeImageReference,
} from "./index.js";

test("short image names expand the way Docker resolves them", () => {
  assert.equal(normalizeImageReference("nginx"), "docker.io/library/nginx:latest");
  assert.equal(normalizeImageReference("nginx:alpine"), "docker.io/library/nginx:alpine");
  assert.equal(normalizeImageReference("traefik/whoami"), "docker.io/traefik/whoami:latest");
  assert.equal(normalizeImageReference("ghcr.io/org/app:1.2"), "ghcr.io/org/app:1.2");
  assert.equal(normalizeImageReference("localhost:5000/app"), "localhost:5000/app:latest");
  const digest = `nginx@sha256:${"a".repeat(64)}`;
  assert.equal(normalizeImageReference(digest), `docker.io/library/${digest}`);
});

test("image references are validated", () => {
  for (const ok of ["nginx", "nginx:1.27-alpine", "ghcr.io/org/app:v1", "registry:5000/a/b"]) {
    assert.ok(IMAGE_REFERENCE_PATTERN.test(ok), ok);
  }
  for (const bad of ["", "Nginx", "nginx:", "a b", "nginx;rm -rf /", "-nginx"]) {
    assert.ok(!IMAGE_REFERENCE_PATTERN.test(bad), bad);
  }
});

test("a minimal project request gets defaults", () => {
  const parsed = createProjectRequestSchema.parse({
    name: "hello",
    source: { type: "image", image: "nginx:alpine" },
    containerPort: 80,
  });
  assert.equal(parsed.healthCheckPath, "/");
  assert.deepEqual(parsed.env, {});
});

test("invalid names, ports and env keys are rejected", () => {
  const base = { name: "hello", source: { type: "image", image: "nginx" }, containerPort: 80 };
  for (const name of ["ab", "Hello", "1app", "app-", "a".repeat(31)]) {
    assert.equal(createProjectRequestSchema.safeParse({ ...base, name }).success, false, name);
  }
  for (const containerPort of [0, 70000, 1.5]) {
    assert.equal(createProjectRequestSchema.safeParse({ ...base, containerPort }).success, false);
  }
  assert.equal(
    createProjectRequestSchema.safeParse({ ...base, env: { "lower-case": "x" } }).success,
    false,
  );
});

test("deployments only move forward", () => {
  assert.ok(canTransition("pending", "deploying"));
  assert.ok(canTransition("deploying", "live"));
  assert.ok(canTransition("live", "superseded"));
  assert.ok(!canTransition("live", "deploying"));
  assert.ok(!canTransition("failed", "pending"));
  assert.ok(!canTransition("superseded", "live"));
});

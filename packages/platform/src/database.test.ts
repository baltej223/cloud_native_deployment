import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseEnv, databaseSettingsFrom, parseEnv } from "./config.js";
import { resolveConnectionString } from "./database.js";

test("a separate password is inserted into the URL, percent-encoded", () => {
  const url = resolveConnectionString(
    "postgresql://postgres@db.example.supabase.co:5432/postgres",
    "p@ss:w/rd#1",
  );
  const parsed = new URL(url);
  assert.equal(decodeURIComponent(parsed.password), "p@ss:w/rd#1");
  assert.equal(parsed.username, "postgres");
  assert.equal(parsed.hostname, "db.example.supabase.co");
  assert.equal(parsed.pathname, "/postgres");
});

test("DATABASE_PASSWORD overrides a password already in the URL", () => {
  const url = resolveConnectionString("postgres://app:old@localhost:5433/db", "new");
  assert.equal(new URL(url).password, "new");
});

test("a URL without a separate password is used as is", () => {
  assert.equal(
    resolveConnectionString("postgres://app:app@postgres:5432/cloud_platform"),
    "postgres://app:app@postgres:5432/cloud_platform",
  );
});

test("a leftover placeholder password is rejected with a clear message", () => {
  assert.throws(
    () =>
      resolveConnectionString(
        "postgresql://postgres:[YOUR-DATABASE-PASSWORD]@db.example.supabase.co:5432/postgres",
      ),
    /set DATABASE_PASSWORD/,
  );
});

test("database env parsing and defaults", () => {
  const env = parseEnv(databaseEnv, {
    DATABASE_URL: "postgres://app@localhost/db",
    DATABASE_PASSWORD: "",
  });
  assert.deepEqual(databaseSettingsFrom(env), {
    url: "postgres://app@localhost/db",
    password: undefined,
    ssl: "disable",
    caFile: undefined,
    maxConnections: 10,
  });
  assert.throws(() =>
    parseEnv(databaseEnv, { DATABASE_URL: "postgres://x@y/z", DATABASE_SSL: "maybe" }),
  );
});

test("USE_SUPABASE accepts only yes or empty", () => {
  const base = {
    DATABASE_URL: "postgresql://postgres.ref@aws-1-x.pooler.supabase.com:5432/postgres",
  };
  assert.equal(parseEnv(databaseEnv, { ...base, USE_SUPABASE: "yes" }).USE_SUPABASE, "yes");
  assert.equal(parseEnv(databaseEnv, { ...base, USE_SUPABASE: "" }).USE_SUPABASE, "");
  assert.equal(parseEnv(databaseEnv, base).USE_SUPABASE, "");
  assert.throws(
    () => parseEnv(databaseEnv, { ...base, USE_SUPABASE: "no" }),
    /must be "yes" or empty/,
  );
});

test("USE_SUPABASE=yes refuses the local database URL", () => {
  const env = parseEnv(databaseEnv, {
    USE_SUPABASE: "yes",
    DATABASE_URL: "postgres://app:app@postgres:5432/cloud_platform",
  });
  assert.throws(() => databaseSettingsFrom(env), /points at the local database/);
});

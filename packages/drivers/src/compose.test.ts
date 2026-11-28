import assert from "node:assert/strict";
import { test } from "node:test";
import {
  choosePublicService,
  containerPortOf,
  durationSeconds,
  interpolate,
  parseCompose,
  parseEnvFile,
  parseHealthcheck,
  splitCommand,
} from "./compose.js";
import { DeployError } from "./types.js";

const FILE = "compose.yaml";

function parse(text: string, files: Record<string, string> = {}, env: Record<string, string> = {}) {
  return parseCompose(text, { file: FILE, env, readFile: (path) => files[path] ?? null });
}

function refused(text: string, pattern: RegExp, files: Record<string, string> = {}) {
  assert.throws(
    () => parse(text, files),
    (error: unknown) => error instanceof DeployError && pattern.test(error.reason),
  );
}

const WEB_AND_DB = `
services:
  web:
    build: .
    ports: ["8080:3000"]
    environment:
      DATABASE_URL: postgres://app:\${DB_PASSWORD:-secret}@db:5432/app
    depends_on: [db]
  db:
    image: postgres:17-alpine
    environment:
      - POSTGRES_PASSWORD=\${DB_PASSWORD:-secret}
    volumes:
      - db-data:/var/lib/postgresql/data
volumes:
  db-data:
`;

test("a web app with a database: dependencies first, the web service gets the URL", () => {
  const parsed = parse(WEB_AND_DB);
  assert.deepEqual(
    parsed.services.map((service) => service.name),
    ["db", "web"],
  );
  const [db, web] = parsed.services;
  assert.equal(db!.image, "docker.io/library/postgres:17-alpine");
  assert.deepEqual(db!.volumes, [
    { name: "db-data", target: "/var/lib/postgresql/data", readOnly: false },
  ]);
  assert.equal(db!.env.POSTGRES_PASSWORD, "secret");
  assert.deepEqual(web!.build, { context: ".", dockerfile: "Dockerfile", args: {}, target: null });
  assert.equal(web!.port, 3000);
  assert.equal(web!.env.DATABASE_URL, "postgres://app:secret@db:5432/app");
  assert.equal(choosePublicService(parsed, FILE).name, "web");
});

test("project variables fill ${VAR} and win over the repository's .env", () => {
  const parsed = parse(WEB_AND_DB, { ".env": "DB_PASSWORD=from-dotenv\n" }, {});
  assert.equal(parsed.services[0]!.env.POSTGRES_PASSWORD, "from-dotenv");
  const overridden = parse(
    WEB_AND_DB,
    { ".env": "DB_PASSWORD=from-dotenv\n" },
    {
      DB_PASSWORD: "from-project",
    },
  );
  assert.equal(overridden.services[0]!.env.POSTGRES_PASSWORD, "from-project");
});

test("interpolation follows Docker Compose", () => {
  const vars = { SET: "x", EMPTY: "" };
  assert.equal(interpolate("$SET-${SET}-$$SET", vars, "t"), "x-x-$SET");
  assert.equal(interpolate("${MISSING:-d} ${EMPTY:-d} ${EMPTY-d}", vars, "t"), "d d ");
  assert.equal(interpolate("${SET:+alt}${EMPTY:+alt}", vars, "t"), "alt");
  assert.throws(() => interpolate("${MISSING:?needed}", vars, "t"), /MISSING \(needed\)/);
});

test("host folders, privileged mode and the host network are refused", () => {
  refused(
    `services:\n  app:\n    image: nginx\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]`,
    /mounts \/var\/run\/docker.sock from the host/,
  );
  refused(`services:\n  app:\n    image: nginx\n    privileged: true`, /privileged/);
  refused(`services:\n  app:\n    image: nginx\n    network_mode: host`, /network mode/);
  refused(`services:\n  app:\n    image: nginx\n    cap_add: [SYS_ADMIN]`, /capabilities/);
  refused(`services:\n  app:\n    build: ../elsewhere\n`, /outside the repository/);
  refused(
    `services:\n  app:\n    image: nginx\nvolumes:\n  data:\n    external: true`,
    /external volume/,
  );
  // Harmless "off" values are fine.
  assert.equal(
    parse(`services:\n  app:\n    image: nginx\n    privileged: false`).services.length,
    1,
  );
});

test("repository folder mounts are copied into the image; anonymous volumes kept", () => {
  const parsed = parse(
    `services:\n  app:\n    build: ./app\n    volumes: ["./app:/usr/local/app", "/app/node_modules", "./app/../shared:/shared:ro"]`,
  );
  assert.deepEqual(parsed.services[0]!.volumes, []);
  assert.deepEqual(parsed.services[0]!.tmpVolumes, ["/app/node_modules"]);
  assert.deepEqual(parsed.services[0]!.copies, [
    { source: "app", target: "/usr/local/app" },
    { source: "shared", target: "/shared" },
  ]);
  refused(
    `services:\n  app:\n    image: a\n    volumes: ["../secrets:/secrets"]`,
    /outside the repository/,
  );
});

test("services with profiles are skipped, unknown settings noted", () => {
  const parsed = parse(
    `services:\n  app:\n    image: nginx\n    ports: ["80"]\n    shm_size: 1g\n  debug:\n    image: busybox\n    profiles: [debug]`,
  );
  assert.deepEqual(
    parsed.services.map((service) => service.name),
    ["app"],
  );
  assert.match(parsed.warnings.join("\n"), /ignoring shm_size/);
  assert.match(parsed.warnings.join("\n"), /profiles: debug/);
});

test("choosing the public service", () => {
  const two = parse(
    `services:\n  api:\n    image: a\n    ports: ["3000:3000"]\n  web:\n    image: b\n    ports: ["80:80"]`,
  );
  assert.throws(
    () => choosePublicService(two, FILE),
    /Several services .* publish ports: api, web/,
  );
  assert.equal(choosePublicService(two, FILE, "web").name, "web");
  assert.throws(() => choosePublicService(two, FILE, "nope"), /no service named nope/);

  const none = parse(`services:\n  a:\n    image: a\n  b:\n    image: b`);
  assert.throws(() => choosePublicService(none, FILE), /None of the services/);

  const single = parse(`services:\n  only:\n    image: a\n    expose: ["5000"]`);
  assert.equal(choosePublicService(single, FILE).name, "only");
  assert.equal(single.services[0]!.port, 5000);
});

test("dependency problems and too many services fail clearly", () => {
  refused(`services:\n  a:\n    image: a\n    depends_on: [missing]`, /depends on missing/);
  refused(
    `services:\n  a:\n    image: a\n    depends_on: [b]\n  b:\n    image: b\n    depends_on:\n      a:\n        condition: service_started`,
    /circle/,
  );
  const many = Array.from({ length: 6 }, (_, i) => `  s${i}:\n    image: x`).join("\n");
  refused(`services:\n${many}`, /at most 5/);
  refused(`services: {}`, /no services/);
  refused(`services:\n  a: [`, /not valid YAML/);
});

test("env_file, build args and commands", () => {
  const parsed = parse(
    `services:\n  app:\n    build:\n      context: ./app\n      dockerfile: docker/Dockerfile.prod\n      args: [VERSION=1, TOKEN]\n      target: runtime\n    env_file: app.env\n    environment: [EXTRA]\n    command: npm run "start prod"\n    entrypoint: ["/bin/sh", "-c"]`,
    { "app.env": "# comment\nexport A=1\nB='two words'\n" },
    { TOKEN: "t", EXTRA: "e" },
  );
  const app = parsed.services[0]!;
  assert.deepEqual(app.build, {
    context: "app",
    dockerfile: "docker/Dockerfile.prod",
    args: { VERSION: "1", TOKEN: "t" },
    target: "runtime",
  });
  assert.deepEqual(app.env, { A: "1", B: "two words", EXTRA: "e" });
  assert.deepEqual(app.command, ["npm", "run", "start prod"]);
  assert.deepEqual(app.entrypoint, ["/bin/sh", "-c"]);
  refused(
    `services:\n  app:\n    image: a\n    env_file: missing.env`,
    /missing.env does not exist/,
  );
});

test("small helpers", () => {
  assert.equal(containerPortOf("127.0.0.1:8080:80/tcp"), 80);
  assert.equal(containerPortOf("3000-3001"), 3000);
  assert.equal(containerPortOf({ target: 5000, published: 80 }), 5000);
  assert.equal(containerPortOf(8080), 8080);
  assert.deepEqual(splitCommand(`echo 'a b' "c \\"d\\"" e\\ f`), ["echo", "a b", 'c "d"', "e f"]);
  assert.deepEqual(parseEnvFile('A=1 # note\nB="x=y"\n'), { A: "1", B: "x=y" });
});

test("healthchecks and service_healthy dependencies are kept", () => {
  const { services } = parse(
    `
services:
  db:
    image: mysql:8.4
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -u$$USER"]
      interval: 3s
      retries: 40
  cache:
    image: redis:7
  app:
    image: app:1
    depends_on:
      db: { condition: service_healthy }
      cache: { condition: service_started }
`,
  );
  const db = services.find((service) => service.name === "db")!;
  assert.deepEqual(db.healthcheck, {
    test: ["CMD-SHELL", "mysqladmin ping -u$USER"],
    intervalSeconds: 3,
    timeoutSeconds: 30,
    retries: 40,
    startPeriodSeconds: 0,
  });
  const app = services.find((service) => service.name === "app")!;
  assert.deepEqual(app.waitFor, ["db"]);
  assert.deepEqual(app.dependsOn.sort(), ["cache", "db"]);
  assert.equal(services.find((service) => service.name === "cache")!.healthcheck, null);
});

test("durations and disabled healthchecks", () => {
  assert.equal(durationSeconds("1m30s", 0), 90);
  assert.equal(durationSeconds("500ms", 0), 0.5);
  assert.equal(durationSeconds(undefined, 30), 30);
  assert.equal(durationSeconds("soon", 30), 30);
  assert.equal(parseHealthcheck({ disable: true }, "x"), null);
  assert.equal(parseHealthcheck({ test: ["NONE"] }, "x"), null);
  assert.deepEqual(parseHealthcheck({ test: "curl -f localhost" }, "x")!.test, [
    "CMD-SHELL",
    "curl -f localhost",
  ]);
});

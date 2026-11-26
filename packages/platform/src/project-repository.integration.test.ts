/**
 * Runs the repository against a real PostgreSQL database, including the
 * migrations and the status-transition trigger. Skipped unless
 * TEST_DATABASE_URL is set; the database is wiped, so use a throwaway one:
 *
 *   TEST_DATABASE_URL=postgres://app:app@localhost:5433/cloud_platform_test npm test
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPool, type DatabasePool } from "./database.js";
import { createLogger } from "./logger.js";
import { runMigrations } from "./migrations.js";
import {
  DeploymentInProgressError,
  NameTakenError,
  NoFreePortError,
  PostgresProjectRepository,
  ProjectLimitError,
} from "./project-repository.js";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL is not set";
const limits = { portRange: { min: 8001, max: 8003 }, maxProjects: 3 };

let pool: DatabasePool;
let repository: PostgresProjectRepository;

before(async () => {
  if (!url) return;
  pool = createPool(url);
  await pool.query(
    "DROP TABLE IF EXISTS deployments, projects, schema_migrations CASCADE; DROP FUNCTION IF EXISTS deployments_check_transition CASCADE",
  );
  await runMigrations(pool, createLogger("test", "silent"));
  repository = new PostgresProjectRepository(pool);
});
after(async () => {
  await pool?.end();
});

const repo = (name: string) =>
  repository.create(
    {
      name,
      source: { type: "repo", repoUrl: `https://github.com/acme/${name}`, branch: "main" },
      containerPort: null,
      healthCheckPath: "/",
      env: { A: "1" },
    },
    limits,
  );

test("projects get ports in order, unique names and a pending deployment", { skip }, async () => {
  const first = await repo("one");
  assert.equal(first.project.assignedPort, 8001);
  assert.deepEqual(first.project.source, {
    type: "repo",
    repoUrl: "https://github.com/acme/one",
    branch: "main",
  });
  assert.equal(first.project.containerPort, null);
  assert.equal(first.deployment.status, "pending");

  await assert.rejects(repo("one"), NameTakenError);
  assert.equal((await repo("two")).project.assignedPort, 8002);
  await repository.create(
    {
      name: "three",
      source: { type: "image", image: "docker.io/library/nginx:alpine" },
      containerPort: 80,
      healthCheckPath: "/",
      env: {},
    },
    limits,
  );
  await assert.rejects(repo("four"), ProjectLimitError);
});

test("the full lifecycle, with build details and timestamps", { skip }, async () => {
  const { project, latest } = (await repository.list()).find((p) => p.project.name === "one")!;
  const id = latest!.id;

  const building = await repository.transition(id, "pending", "building");
  assert.ok(building?.startedAt);
  assert.equal(building.deployStartedAt, null);

  await repository.setBuildLog(id, "Step 1/2\n");
  assert.equal(await repository.getBuildLog(id), "Step 1/2\n");

  const deploying = await repository.transition(id, "building", "deploying", {
    imageRef: "localhost/cp-app-x:abc",
    commitSha: "abc123",
    dockerfilePath: "web/Dockerfile",
    contextPath: "web",
    containerPort: 3000,
  });
  assert.equal(deploying?.containerPort, 3000);
  assert.equal(deploying?.dockerfilePath, "web/Dockerfile");
  assert.ok(deploying?.deployStartedAt);

  const work = await repository.findWork();
  assert.ok(work.deployments.some((w) => w.deployment.id === id && w.project.id === project.id));

  const live = await repository.transition(id, "deploying", "live");
  assert.ok(live?.finishedAt);
  const entry = (await repository.get(project.id))!;
  assert.equal(entry.live?.id, id);
  assert.equal(entry.latest?.id, id);
});

test("only valid transitions happen; stale ones return null", { skip }, async () => {
  const { latest } = (await repository.list()).find((p) => p.project.name === "one")!;
  // Already live: a stale "deploying -> failed" is ignored.
  assert.equal(await repository.transition(latest!.id, "deploying", "failed"), null);
  // The trigger rejects backwards moves even from raw SQL.
  await assert.rejects(
    pool.query("UPDATE deployments SET status = 'pending' WHERE id = $1", [latest!.id]),
    /invalid deployment transition live -> pending/,
  );
});

test("one deployment in progress per project; going live supersedes", { skip }, async () => {
  const { project, latest: first } = (await repository.list()).find(
    (p) => p.project.name === "one",
  )!;
  const second = (await repository.createDeployment(project.id))!;
  await assert.rejects(repository.createDeployment(project.id), DeploymentInProgressError);

  await repository.transition(second.id, "pending", "building");
  await repository.transition(second.id, "building", "deploying");
  await repository.transition(second.id, "deploying", "live");

  assert.equal((await repository.getDeployment(first!.id))!.status, "superseded");
  const history = await repository.listDeployments(project.id);
  assert.deepEqual(
    history.map((d) => d.id),
    [second.id, first!.id],
  );
});

test("deleting frees the name and port", { skip }, async () => {
  const { project } = (await repository.list()).find((p) => p.project.name === "two")!;
  assert.equal(await repository.markDeleted(project.id), true);
  assert.equal((await repository.get(project.id))!.project.deletedAt !== null, true);
  assert.ok((await repository.findWork()).deletions.some((p) => p.id === project.id));

  await repository.remove(project.id);
  assert.equal(await repository.get(project.id), null);
  assert.equal(await repository.createDeployment(project.id), null);
  assert.equal((await repo("two")).project.assignedPort, 8002);
  await assert.rejects(repo("five"), ProjectLimitError);
});

test("no free port is reported when the range is used up", { skip }, async () => {
  await pool.query("DELETE FROM projects WHERE name = 'three'");
  await assert.rejects(
    repository.create(
      {
        name: "six",
        source: { type: "image", image: "docker.io/library/nginx:alpine" },
        containerPort: 80,
        healthCheckPath: "/",
        env: {},
      },
      { portRange: { min: 8001, max: 8002 }, maxProjects: 10 },
    ),
    NoFreePortError,
  );
});

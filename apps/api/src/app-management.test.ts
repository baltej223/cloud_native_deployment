import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type {
  CreateProjectResponse,
  DeploymentView,
  ProjectView,
  RuntimeLogResponse,
} from "@cloud-platform/contracts";
import { FakeBuilder, FakeRouter, FakeRuntime } from "@cloud-platform/drivers/testing";
import { createLogger } from "@cloud-platform/platform";
import { InMemoryProjectRepository } from "@cloud-platform/platform/testing";
import { createApp } from "./app.js";
import { DeploymentController } from "./controller.js";
import { ProjectsService } from "./projects-service.js";

// The API and the controller together on fakes: settings, stop/start,
// rollback and runtime logs, end to end.

const logger = createLogger("app-management-test", "silent");
const repository = new InMemoryProjectRepository();
const runtime = new FakeRuntime();
const builder = new FakeBuilder();
const router = new FakeRouter();
const controller = new DeploymentController(repository, builder, runtime, router, logger, {
  intervalMs: 1_000,
  buildTimeoutMs: 60_000,
  healthTimeoutMs: 60_000,
  deployTimeoutMs: 600_000,
  logFlushMs: 10,
  restartBackoffMs: 0,
});
let baseUrl = "";
let close: () => void;

before(async () => {
  const app = createApp({
    projects: new ProjectsService(
      repository,
      router,
      runtime,
      { portRange: { min: 8001, max: 8010 }, maxProjects: 10 },
      logger,
    ),
    logger,
    allowedOrigins: ["http://localhost:3000"],
    readinessChecks: {},
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const project = async (id: string) =>
  (await (await call("GET", `/projects/${id}`)).json()) as ProjectView;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await controller.tick();
    await controller.idle();
  }
}

let id = "";
let first = "";

test("setup: a repository project goes live", async () => {
  const response = await call("POST", "/projects", {
    source: { type: "repo", repoUrl: "https://github.com/acme/shop" },
  });
  const created = (await response.json()) as CreateProjectResponse;
  id = created.project.id;
  first = created.deployment.id;
  await settle();
  const view = await project(id);
  assert.equal(view.status, "live");
  assert.equal(view.desiredState, "running");
});

test("PATCH changes settings for the next deployment and rejects bad input", async () => {
  let response = await call("PATCH", `/projects/${id}`, {
    env: { GREETING: "hi" },
    containerPort: 8080,
    composeService: "web",
  });
  assert.equal(response.status, 200);
  const view = (await response.json()) as ProjectView;
  assert.deepEqual(view.env, { GREETING: "hi" });
  assert.equal(view.containerPort, 8080);
  assert.equal(view.source.type === "repo" && view.source.composeService, "web");

  response = await call("PATCH", `/projects/${id}`, { composeService: null, containerPort: null });
  const cleared = (await response.json()) as ProjectView;
  assert.equal(cleared.containerPort, null);
  assert.equal(cleared.source.type === "repo" && cleared.source.composeService, undefined);

  response = await call("PATCH", `/projects/${id}`, { name: "renamed" });
  assert.equal(response.status, 400);
  assert.match(
    ((await response.json()) as { error: { message: string } }).error.message,
    /name cannot be changed/,
  );
  assert.equal((await call("PATCH", `/projects/${id}`, {})).status, 400);
  assert.equal((await call("PATCH", `/projects/${id}`, { containerPort: 0 })).status, 400);
});

test("stop and start: the controller stops and starts the containers", async () => {
  let response = await call("POST", `/projects/${id}/stop`);
  assert.equal(response.status, 202);
  assert.equal(((await response.json()) as ProjectView).status, "stopped");
  await settle();
  assert.deepEqual(runtime.stopped, [id]);
  assert.equal((await runtime.inspect(id)).state, "exited");
  const stopped = await project(id);
  assert.equal(stopped.stopReason, "user");

  response = await call("POST", `/projects/${id}/start`);
  assert.equal(response.status, 202);
  await settle();
  assert.equal((await runtime.inspect(id)).state, "running");
  assert.equal((await project(id)).status, "live");
  assert.equal(builder.requests.length, 1, "starting does not rebuild");
});

test("rollback deploys an earlier image without building", async () => {
  // A second version goes live first.
  assert.equal((await call("POST", `/projects/${id}/deployments`)).status, 202);
  await settle();
  const second = (await project(id)).liveDeployment!;
  assert.notEqual(second.id, first);
  assert.equal(builder.requests.length, 2);

  let response = await call("POST", `/projects/${id}/rollback`, { deploymentId: first });
  assert.equal(response.status, 202);
  const rollback = (await response.json()) as DeploymentView;
  assert.equal(rollback.rollbackOf, first);
  await settle();

  const view = await project(id);
  assert.equal(view.liveDeployment!.id, rollback.id);
  assert.equal(view.liveDeployment!.imageRef, `localhost/cp-app-${id}:${first.slice(0, 12)}`);
  assert.equal(builder.requests.length, 2, "no build for a rollback");
  assert.equal(runtime.deployed.at(-1)!.pull, false);

  // The live one cannot be rolled back to; unknown ones are 404.
  response = await call("POST", `/projects/${id}/rollback`, { deploymentId: rollback.id });
  assert.equal(response.status, 409);
  response = await call("POST", `/projects/${id}/rollback`, {
    deploymentId: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(response.status, 404);
  assert.equal((await call("POST", `/projects/${id}/rollback`, {})).status, 400);
});

test("runtime logs come from the running app", async () => {
  runtime.logLines.set(`${id}/`, "2026-11-27T10:00:00Z listening on 3000\n");
  let response = await call("GET", `/projects/${id}/logs?tail=50`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as RuntimeLogResponse;
  assert.equal(body.log, "2026-11-27T10:00:00Z listening on 3000\n");
  assert.equal(body.service, null);
  assert.deepEqual(body.services, []);

  response = await call("GET", `/projects/${id}/logs?service=db`);
  assert.equal(response.status, 400, "no services in a single-container app");
  assert.equal((await call("GET", `/projects/${id}/logs?tail=0`)).status, 400);
});

test("projects without a live version cannot be started or stopped", async () => {
  builder.failWith = "The build failed: boom";
  const response = await call("POST", "/projects", {
    name: "broken",
    source: { type: "repo", repoUrl: "https://github.com/acme/broken" },
  });
  const { project: created } = (await response.json()) as CreateProjectResponse;
  await settle();
  builder.failWith = null;
  assert.equal((await call("POST", `/projects/${created.id}/start`)).status, 409);
  assert.equal((await call("POST", `/projects/${created.id}/stop`)).status, 409);
});

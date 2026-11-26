import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { FakeRouter, FakeRuntime } from "@cloud-platform/drivers/testing";
import { createLogger } from "@cloud-platform/platform";
import { InMemoryProjectRepository } from "@cloud-platform/platform/testing";
import { DeploymentController } from "./controller.js";

const logger = createLogger("controller-test", "silent");
const limits = { portRange: { min: 8001, max: 8010 }, maxProjects: 10 };
const HEALTH_TIMEOUT = 60_000;
const DEPLOY_TIMEOUT = 600_000;

let repository: InMemoryProjectRepository;
let runtime: FakeRuntime;
let router: FakeRouter;
let controller: DeploymentController;
let clock: number;

beforeEach(() => {
  clock = Date.parse("2026-11-26T10:00:00Z");
  repository = new InMemoryProjectRepository();
  repository.now = () => new Date(clock);
  runtime = new FakeRuntime();
  runtime.clock = () => clock;
  router = new FakeRouter();
  controller = new DeploymentController(repository, runtime, router, logger, {
    intervalMs: 1_000,
    healthTimeoutMs: HEALTH_TIMEOUT,
    deployTimeoutMs: DEPLOY_TIMEOUT,
    now: () => clock,
  });
});

const createProject = (image = "docker.io/library/nginx:alpine", name = "hello") =>
  repository.create(
    {
      name,
      source: { type: "image", image },
      containerPort: 80,
      healthCheckPath: "/",
      env: { A: "1" },
    },
    limits,
  );

const statusOf = async (projectId: string) => (await repository.get(projectId))!.latest!.status;

async function ticks(count: number) {
  for (let i = 0; i < count; i++) await controller.tick();
}

test("an image deployment goes pending -> deploying -> live", async () => {
  const { project, deployment } = await createProject();

  await controller.tick();
  assert.equal(await statusOf(project.id), "deploying");
  assert.equal((await repository.get(project.id))!.latest!.imageRef, project.source.image);

  await controller.tick();
  assert.equal(runtime.deployed.length, 1);
  assert.deepEqual(runtime.deployed[0], {
    projectId: project.id,
    deploymentId: deployment.id,
    image: "docker.io/library/nginx:alpine",
    containerPort: 80,
    env: { A: "1" },
    publicPort: 8001,
  });

  await controller.tick();
  assert.equal(await statusOf(project.id), "live");

  // Nothing more to do once live: no redeploys.
  await ticks(3);
  assert.equal(runtime.deployed.length, 1);
});

test("a missing image fails with the driver's reason and nothing is left running", async () => {
  runtime.missingImages.add("docker.io/library/nope:latest");
  const { project } = await createProject("docker.io/library/nope:latest");
  await ticks(2);
  const latest = (await repository.get(project.id))!.latest!;
  assert.equal(latest.status, "failed");
  assert.match(latest.failureReason!, /was not found, or it is private/);
  assert.equal(runtime.apps.size, 0);
});

test("an app that crashes on start fails and its container is removed", async () => {
  runtime.initialState = "restarting";
  const { project } = await createProject();
  await ticks(3);
  const latest = (await repository.get(project.id))!.latest!;
  assert.equal(latest.status, "failed");
  assert.match(latest.failureReason!, /exited with code 1/);
  assert.deepEqual(runtime.removed, [project.id]);
});

test("an app that never answers fails after the health timeout, counted from container start", async () => {
  const { project } = await createProject();
  router.unhealthy.add(project.id);
  await ticks(2); // deploying, container started

  clock += HEALTH_TIMEOUT - 1_000;
  await controller.tick();
  assert.equal(await statusOf(project.id), "deploying");

  clock += 2_000;
  await controller.tick();
  const latest = (await repository.get(project.id))!.latest!;
  assert.equal(latest.status, "failed");
  assert.match(latest.failureReason!, /did not answer on port 80 at \/ within 60 s/);
  assert.equal(runtime.apps.size, 0);
});

test("a deployment that cannot start at all fails after the overall timeout", async () => {
  const { project } = await createProject();
  await controller.tick(); // -> deploying
  runtime.deploy = async () => {
    throw new Error("engine unreachable");
  };
  await controller.tick(); // error is logged and retried later
  assert.equal(await statusOf(project.id), "deploying");

  clock += DEPLOY_TIMEOUT + 1_000;
  await controller.tick();
  assert.equal(await statusOf(project.id), "failed");
});

test("a controller restart resumes an unfinished deployment", async () => {
  const { project } = await createProject();
  await ticks(2); // deploying, container started

  const restarted = new DeploymentController(repository, runtime, router, logger, {
    intervalMs: 1_000,
    healthTimeoutMs: HEALTH_TIMEOUT,
    deployTimeoutMs: DEPLOY_TIMEOUT,
    now: () => clock,
  });
  await restarted.tick();
  assert.equal(await statusOf(project.id), "live");
  assert.equal(runtime.deployed.length, 1, "the running container is reused, not redeployed");
});

test("deleting a project removes its app and then its record", async () => {
  const { project } = await createProject();
  await ticks(3);
  assert.equal(await statusOf(project.id), "live");

  await repository.markDeleted(project.id);
  await controller.tick();
  assert.deepEqual(runtime.removed, [project.id]);
  assert.equal(await repository.get(project.id), null);

  // The port is free again.
  const { project: next } = await createProject(undefined, "next");
  assert.equal(next.assignedPort, 8001);
});

test("one failing project does not block others", async () => {
  runtime.missingImages.add("docker.io/library/broken:latest");
  const broken = await createProject("docker.io/library/broken:latest", "broken");
  const good = await createProject(undefined, "good");
  await ticks(3);
  assert.equal(await statusOf(broken.project.id), "failed");
  assert.equal(await statusOf(good.project.id), "live");
});

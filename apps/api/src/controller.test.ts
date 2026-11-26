import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ProjectSource } from "@cloud-platform/contracts";
import { FakeBuilder, FakeRouter, FakeRuntime } from "@cloud-platform/drivers/testing";
import { createLogger } from "@cloud-platform/platform";
import { InMemoryProjectRepository } from "@cloud-platform/platform/testing";
import { DeploymentController } from "./controller.js";

const logger = createLogger("controller-test", "silent");
const limits = { portRange: { min: 8001, max: 8010 }, maxProjects: 10 };
const HEALTH_TIMEOUT = 60_000;
const DEPLOY_TIMEOUT = 600_000;
const REPO: ProjectSource = { type: "repo", repoUrl: "https://github.com/acme/app" };
const NGINX: ProjectSource = { type: "image", image: "docker.io/library/nginx:alpine" };

let repository: InMemoryProjectRepository;
let builder: FakeBuilder;
let runtime: FakeRuntime;
let router: FakeRouter;
let controller: DeploymentController;
let clock: number;

const newController = () =>
  new DeploymentController(repository, builder, runtime, router, logger, {
    intervalMs: 1_000,
    buildTimeoutMs: 60_000,
    healthTimeoutMs: HEALTH_TIMEOUT,
    deployTimeoutMs: DEPLOY_TIMEOUT,
    logFlushMs: 10,
    now: () => clock,
  });

beforeEach(() => {
  clock = Date.parse("2026-11-26T10:00:00Z");
  repository = new InMemoryProjectRepository();
  repository.now = () => new Date(clock);
  builder = new FakeBuilder();
  runtime = new FakeRuntime();
  runtime.clock = () => clock;
  router = new FakeRouter();
  controller = newController();
});

const createProject = (
  source: ProjectSource = NGINX,
  name = "hello",
  containerPort: number | null = source.type === "image" ? 80 : null,
) =>
  repository.create({ name, source, containerPort, healthCheckPath: "/", env: { A: "1" } }, limits);

const latestOf = async (projectId: string) => (await repository.get(projectId))!.latest!;
const statusOf = async (projectId: string) => (await latestOf(projectId)).status;

/** Run ticks, letting background builds finish in between. */
async function ticks(count: number) {
  for (let i = 0; i < count; i++) {
    await controller.tick();
    await controller.idle();
  }
}

// ---------------------------------------------------------------------------
// Image sources
// ---------------------------------------------------------------------------

test("an image deployment goes pending -> deploying -> live", async () => {
  const { project, deployment } = await createProject();

  await controller.tick();
  assert.equal(await statusOf(project.id), "deploying");

  await controller.tick();
  assert.deepEqual(runtime.deployed[0], {
    projectId: project.id,
    deploymentId: deployment.id,
    image: "docker.io/library/nginx:alpine",
    containerPort: 80,
    env: { PORT: "80", A: "1" },
    publicPort: 8001,
    pull: true,
  });

  await controller.tick();
  assert.equal(await statusOf(project.id), "live");
  await ticks(3);
  assert.equal(runtime.deployed.length, 1, "nothing more to do once live");
  assert.equal(builder.requests.length, 0, "images are not built");
});

test("a missing image fails with the driver's reason and nothing is left running", async () => {
  runtime.missingImages.add("docker.io/library/nope:latest");
  const { project } = await createProject({
    type: "image",
    image: "docker.io/library/nope:latest",
  });
  await ticks(2);
  const latest = await latestOf(project.id);
  assert.equal(latest.status, "failed");
  assert.match(latest.failureReason!, /was not found, or it is private/);
  assert.equal(runtime.apps.size, 0);
});

test("an app that crashes on start fails and its container is removed", async () => {
  runtime.initialState = "restarting";
  const { project } = await createProject();
  await ticks(3);
  const latest = await latestOf(project.id);
  assert.equal(latest.status, "failed");
  assert.match(latest.failureReason!, /exited with code 1/);
  assert.deepEqual(runtime.removed, [project.id]);
});

test("an app that never answers fails after the health timeout, counted from container start", async () => {
  const { project } = await createProject();
  router.unhealthy.add(project.id);
  await ticks(2);

  clock += HEALTH_TIMEOUT - 1_000;
  await controller.tick();
  assert.equal(await statusOf(project.id), "deploying");

  clock += 2_000;
  await controller.tick();
  const latest = await latestOf(project.id);
  assert.equal(latest.status, "failed");
  assert.match(latest.failureReason!, /did not answer on port 80 at \/ within 60 s/);
  assert.equal(runtime.apps.size, 0);
});

test("a deployment that cannot start at all fails after the overall timeout", async () => {
  const { project } = await createProject();
  await controller.tick();
  runtime.deploy = async () => {
    throw new Error("engine unreachable");
  };
  await controller.tick();
  assert.equal(await statusOf(project.id), "deploying");

  clock += DEPLOY_TIMEOUT + 1_000;
  await controller.tick();
  assert.equal(await statusOf(project.id), "failed");
});

test("a controller restart resumes an unfinished deployment", async () => {
  const { project } = await createProject();
  await ticks(2);
  controller = newController();
  await controller.tick();
  assert.equal(await statusOf(project.id), "live");
  assert.equal(runtime.deployed.length, 1, "the running container is reused, not redeployed");
});

test("one failing project does not block others", async () => {
  runtime.missingImages.add("docker.io/library/broken:latest");
  const broken = await createProject(
    { type: "image", image: "docker.io/library/broken:latest" },
    "broken",
  );
  const good = await createProject(NGINX, "good");
  await ticks(3);
  assert.equal(await statusOf(broken.project.id), "failed");
  assert.equal(await statusOf(good.project.id), "live");
});

// ---------------------------------------------------------------------------
// Repository sources
// ---------------------------------------------------------------------------

test("a repository is built, its EXPOSE port used, and the built image run without pulling", async () => {
  builder.exposedPort = 3000;
  const { project, deployment } = await createProject(REPO, "app");

  await controller.tick();
  assert.equal(await statusOf(project.id), "building");

  await ticks(1); // build runs and finishes
  const built = await latestOf(project.id);
  assert.equal(built.status, "deploying");
  assert.equal(built.containerPort, 3000);
  assert.equal(built.dockerfilePath, "Dockerfile");
  assert.equal(built.commitSha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(builder.requests[0]!.repoUrl, "https://github.com/acme/app");

  await ticks(2);
  assert.equal(await statusOf(project.id), "live");
  const spec = runtime.deployed[0]!;
  assert.equal(spec.pull, false);
  assert.equal(spec.containerPort, 3000);
  assert.deepEqual(spec.env, { PORT: "3000", A: "1" });
  assert.equal(spec.image, built.imageRef);

  const log = await repository.getBuildLog(deployment.id);
  assert.match(log!, /Cloning/);
  assert.match(log!, /listen on port 3000 \(from EXPOSE\)/);
});

test("a port set by the user wins over EXPOSE", async () => {
  builder.exposedPort = 3000;
  const { project } = await createProject(REPO, "app", 8080);
  await ticks(4);
  assert.equal((await latestOf(project.id)).containerPort, 8080);
  assert.equal(runtime.deployed[0]!.containerPort, 8080);
});

test("without EXPOSE or a user port, the build fails asking for the port", async () => {
  builder.exposedPort = null;
  const { project } = await createProject(REPO, "app");
  await ticks(2);
  const latest = await latestOf(project.id);
  assert.equal(latest.status, "failed");
  assert.match(latest.failureReason!, /no EXPOSE instruction.*Set the container port/);
  assert.equal(runtime.deployed.length, 0);
});

test("a failing build records the reason and the log", async () => {
  builder.failWith = "No Dockerfile found in https://github.com/acme/app.";
  const { project, deployment } = await createProject(REPO, "app");
  await ticks(2);
  const latest = await latestOf(project.id);
  assert.equal(latest.status, "failed");
  assert.match(latest.failureReason!, /No Dockerfile found/);
  assert.match((await repository.getBuildLog(deployment.id))!, /Failed: No Dockerfile found/);
});

test("ticks during a build do not start a second build", async () => {
  builder.autoFinish = false;
  const { project, deployment } = await createProject(REPO, "app");
  await controller.tick(); // -> building
  await controller.tick(); // build starts
  await controller.tick();
  await controller.tick();
  assert.equal(builder.requests.length, 1);
  assert.equal(await statusOf(project.id), "building");
  builder.finish(deployment.id);
  await controller.idle();
  assert.equal(await statusOf(project.id), "deploying");
});

test("a build interrupted by a restart is started again", async () => {
  builder.autoFinish = false;
  const { project, deployment } = await createProject(REPO, "app");
  await controller.tick();
  await controller.tick();
  await controller.stop(); // aborts the build; the deployment stays "building"
  assert.equal(await statusOf(project.id), "building");

  builder.autoFinish = true;
  controller = newController();
  await ticks(1);
  assert.equal(builder.requests.length, 2);
  assert.equal(await statusOf(project.id), "deploying");
  assert.equal((await latestOf(project.id)).id, deployment.id);
});

test("deleting a project during a build aborts it and removes everything", async () => {
  builder.autoFinish = false;
  const { project } = await createProject(REPO, "app");
  await controller.tick();
  await controller.tick();
  const request = builder.requests[0]!;

  await repository.markDeleted(project.id);
  await controller.tick();
  await controller.idle();
  assert.equal(request.signal.aborted, true);
  assert.equal(await repository.get(project.id), null);
});

test("deleting a repository project removes its container, built images and record", async () => {
  const { project } = await createProject(REPO, "app");
  await ticks(4);
  const image = (await latestOf(project.id)).imageRef!;

  await repository.markDeleted(project.id);
  await controller.tick();
  assert.deepEqual(runtime.removed, [project.id]);
  assert.deepEqual(runtime.removedImages, [image]);
  assert.equal(await repository.get(project.id), null);

  const { project: next } = await createProject(NGINX, "next");
  assert.equal(next.assignedPort, 8001, "the port is free again");
});

// ---------------------------------------------------------------------------
// Redeploys
// ---------------------------------------------------------------------------

test("a successful redeploy supersedes the previous live deployment", async () => {
  const { project, deployment: first } = await createProject(REPO, "app");
  await ticks(4);
  assert.equal(await statusOf(project.id), "live");

  const second = (await repository.createDeployment(project.id))!;
  await ticks(4);
  assert.equal((await repository.getDeployment(second.id))!.status, "live");
  assert.equal((await repository.getDeployment(first.id))!.status, "superseded");
  assert.equal(builder.requests.length, 2);
});

test("a failed redeploy restores the previous live version", async () => {
  const { project, deployment: first } = await createProject(REPO, "app");
  await ticks(4);
  const liveImage = (await latestOf(project.id)).imageRef;

  // The new version crashes on start.
  const second = (await repository.createDeployment(project.id))!;
  runtime.initialState = "restarting";
  await ticks(4);
  assert.equal((await repository.getDeployment(second.id))!.status, "failed");

  const entry = (await repository.get(project.id))!;
  assert.equal(entry.live!.id, first.id, "the old deployment is still live");
  const running = runtime.apps.get(project.id)!;
  assert.equal(running.spec.deploymentId, first.id);
  assert.equal(running.spec.image, liveImage);
});

// ---------------------------------------------------------------------------
// Compose apps
// ---------------------------------------------------------------------------

const service = (name: string, image: string, pull: boolean) => ({
  name,
  image,
  pull,
  command: null,
  entrypoint: null,
  env: {},
  volumes: [],
  tmpVolumes: [],
  workingDir: null,
  user: null,
  restart: "unless-stopped" as const,
  dependsOn: [],
});

test("a compose app runs all its services and keeps the plan with the deployment", async () => {
  const { project, deployment } = await createProject(REPO, "shop");
  const web = service("web", `localhost/cp-app-${project.id}-web:x`, false);
  const db = service("db", "docker.io/library/postgres:17-alpine", true);
  builder.compose = { file: "compose.yaml", publicService: "web", services: [db, web] };
  builder.exposedPort = 3000;

  await ticks(3);
  assert.equal(builder.requests[0]!.env.A, "1", "project variables reach the compose file");
  const spec = runtime.deployed[0]!;
  assert.deepEqual(spec.compose, builder.compose);
  assert.deepEqual(spec.env, {}, "no PORT or project env injected into compose services");
  assert.equal((await latestOf(project.id)).compose?.publicService, "web");

  // A few restarts while the database starts are tolerated.
  runtime.apps.get(project.id)!.state = {
    state: "running",
    deploymentId: deployment.id,
    exitCode: null,
    restartCount: 2,
    startedAt: new Date(clock),
  };
  await ticks(1);
  assert.equal(await statusOf(project.id), "live");

  // Deleting removes built images and volumes, but not pulled images.
  await repository.markDeleted(project.id);
  await ticks(1);
  assert.deepEqual(runtime.removedImages, [web.image]);
  assert.deepEqual(runtime.removedData, [project.id]);
});

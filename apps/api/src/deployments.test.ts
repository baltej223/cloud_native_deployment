import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type {
  BuildLogResponse,
  CreateProjectResponse,
  DeploymentView,
  ListDeploymentsResponse,
} from "@cloud-platform/contracts";
import { FakeRouter } from "@cloud-platform/drivers/testing";
import { createLogger } from "@cloud-platform/platform";
import { InMemoryProjectRepository } from "@cloud-platform/platform/testing";
import { createApp } from "./app.js";
import { ProjectsService } from "./projects-service.js";

const logger = createLogger("api-test", "silent");
const repository = new InMemoryProjectRepository();
let baseUrl = "";
let close: () => void;

before(async () => {
  const app = createApp({
    projects: new ProjectsService(
      repository,
      new FakeRouter(),
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

const post = (path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let projectId = "";
let firstDeploymentId = "";

test("a repository URL alone is enough to create a project", async () => {
  const response = await post("/projects", {
    source: { type: "repo", repoUrl: "https://github.com/Acme/My_Web.App.git/" },
  });
  assert.equal(response.status, 201);
  const { project, deployment } = (await response.json()) as CreateProjectResponse;
  assert.equal(project.name, "my-web-app", "name derived from the repository");
  assert.deepEqual(project.source, { type: "repo", repoUrl: "https://github.com/Acme/My_Web.App" });
  assert.equal(project.containerPort, null, "port is detected later");
  assert.equal(project.liveDeployment, null);
  assert.equal(deployment.status, "pending");
  projectId = project.id;
  firstDeploymentId = deployment.id;
});

test("a derived name that is taken asks for another name", async () => {
  const response = await post("/projects", {
    source: { type: "repo", repoUrl: "https://github.com/someone-else/my-web-app" },
  });
  assert.equal(response.status, 409);
  const { error } = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(error.code, "NAME_TAKEN");
  assert.match(error.message, /Choose a different project name/);
});

test("branch and Dockerfile path are kept as overrides", async () => {
  const response = await post("/projects", {
    name: "other",
    source: {
      type: "repo",
      repoUrl: "https://github.com/acme/mono",
      branch: "release/1.2",
      dockerfilePath: "services/web/Dockerfile",
    },
    containerPort: 8080,
  });
  const { project } = (await response.json()) as CreateProjectResponse;
  assert.deepEqual(project.source, {
    type: "repo",
    repoUrl: "https://github.com/acme/mono",
    branch: "release/1.2",
    dockerfilePath: "services/web/Dockerfile",
  });
  assert.equal(project.containerPort, 8080);
});

test("a redeploy is refused while a deployment is in progress", async () => {
  const response = await post(`/projects/${projectId}/deployments`);
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "DEPLOYMENT_IN_PROGRESS",
  );
});

test("a redeploy starts a new deployment once the previous one finished", async () => {
  await repository.transition(firstDeploymentId, "pending", "building");
  await repository.transition(firstDeploymentId, "building", "failed", {
    failureReason: "boom",
  });
  const response = await post(`/projects/${projectId}/deployments`);
  assert.equal(response.status, 202);
  const deployment = (await response.json()) as DeploymentView;
  assert.equal(deployment.status, "pending");
  assert.equal(response.headers.get("location"), `/deployments/${deployment.id}`);

  const list = (await (
    await fetch(`${baseUrl}/projects/${projectId}/deployments`)
  ).json()) as ListDeploymentsResponse;
  assert.deepEqual(
    list.deployments.map((d) => d.status),
    ["pending", "failed"],
    "newest first",
  );
});

test("deployments and their build logs can be read by ID", async () => {
  await repository.setBuildLog(firstDeploymentId, "==> Cloning\nStep 1/3 : FROM node\n");
  const deployment = (await (
    await fetch(`${baseUrl}/deployments/${firstDeploymentId}`)
  ).json()) as DeploymentView;
  assert.equal(deployment.failureReason, "boom");

  const logs = (await (
    await fetch(`${baseUrl}/deployments/${firstDeploymentId}/logs`)
  ).json()) as BuildLogResponse;
  assert.equal(logs.status, "failed");
  assert.match(logs.log, /Step 1\/3/);
  assert.equal(logs.truncated, false);
});

test("unknown projects and deployments return 404", async () => {
  const unknown = "00000000-0000-4000-8000-000000000000";
  assert.equal((await post(`/projects/${unknown}/deployments`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/projects/${unknown}/deployments`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/deployments/${unknown}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/deployments/nope/logs`)).status, 404);
});

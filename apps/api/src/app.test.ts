import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type {
  CreateProjectResponse,
  ListProjectsResponse,
  ProjectView,
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
      { portRange: { min: 8001, max: 8003 }, maxProjects: 3 },
      logger,
    ),
    logger,
    allowedOrigins: ["http://localhost:3000"],
    readinessChecks: { database: () => repository.ping() },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const create = (body: unknown) =>
  fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

test("POST /projects creates a project with a pending deployment and a URL", async () => {
  const response = await create({
    name: "hello-nginx",
    source: { type: "image", image: "nginx:alpine" },
    containerPort: 80,
    env: { GREETING: "hi" },
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as CreateProjectResponse;
  assert.equal(response.headers.get("location"), `/projects/${body.project.id}`);
  assert.equal(body.project.status, "pending");
  assert.equal(body.project.url, "http://apps.test:8001");
  assert.deepEqual(body.project.source, { type: "image", image: "docker.io/library/nginx:alpine" });
  assert.equal(body.project.healthCheckPath, "/");
  assert.deepEqual(body.project.env, { GREETING: "hi" });
  assert.equal(body.deployment.status, "pending");
});

test("each project gets its own port, and duplicate names are rejected", async () => {
  const second = await create({
    name: "second",
    source: { type: "image", image: "nginx" },
    containerPort: 80,
  });
  assert.equal(
    ((await second.json()) as CreateProjectResponse).project.url,
    "http://apps.test:8002",
  );

  const duplicate = await create({
    name: "second",
    source: { type: "image", image: "nginx" },
    containerPort: 80,
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await errorOf(duplicate)).code, "NAME_TAKEN");
});

test("the project limit is enforced", async () => {
  assert.equal(
    (await create({ name: "third", source: { type: "image", image: "nginx" }, containerPort: 80 }))
      .status,
    201,
  );
  const fourth = await create({
    name: "fourth",
    source: { type: "image", image: "nginx" },
    containerPort: 80,
  });
  assert.equal(fourth.status, 409);
  assert.equal((await errorOf(fourth)).code, "PROJECT_LIMIT_REACHED");
});

test("invalid requests return 400 with a readable message and create nothing", async () => {
  const before = repository.projects.size;
  const cases: Array<[unknown, RegExp]> = [
    ["not json", /valid JSON/],
    [[], /JSON object/],
    [{ source: { type: "image", image: "nginx" }, containerPort: 80 }, /name is required/],
    [
      { name: "Bad Name", source: { type: "image", image: "nginx" }, containerPort: 80 },
      /lowercase/,
    ],
    [{ name: "okname", source: { type: "zip" }, containerPort: 80 }, /"repo" or "image"/],
    [{ source: { type: "repo", repoUrl: "https://gitlab.com/a/b" } }, /public GitHub repository/],
    [
      { source: { type: "repo", repoUrl: "https://github.com/a/b", branch: "--upload-pack=x" } },
      /not a valid branch/,
    ],
    [
      { source: { type: "repo", repoUrl: "https://github.com/a/b", dockerfilePath: "../x" } },
      /inside the repository/,
    ],
    [{ name: "okname", source: { type: "image", image: "nginx" } }, /containerPort is required/],
    [
      { name: "okname", source: { type: "image", image: "NOT VALID" }, containerPort: 80 },
      /not a valid image/,
    ],
    [
      { name: "okname", source: { type: "image", image: "nginx" }, containerPort: 0 },
      /between 1 and 65535/,
    ],
    [
      {
        name: "okname",
        source: { type: "image", image: "nginx" },
        containerPort: 80,
        env: { "bad-key": "x" },
      },
      /MY_VAR/,
    ],
  ];
  for (const [body, message] of cases) {
    const response = await create(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = await errorOf(response);
    assert.equal(error.code, "INVALID_INPUT");
    assert.match(error.message, message);
  }
  assert.equal(repository.projects.size, before);
});

test("GET /projects lists projects, newest first", async () => {
  const response = await fetch(`${baseUrl}/projects`);
  assert.equal(response.status, 200);
  const { projects } = (await response.json()) as ListProjectsResponse;
  assert.deepEqual(
    projects.map((project) => project.name),
    ["third", "second", "hello-nginx"],
  );
});

test("GET /projects/:id returns 404 for unknown or malformed IDs", async () => {
  for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
    const response = await fetch(`${baseUrl}/projects/${id}`);
    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).code, "PROJECT_NOT_FOUND");
  }
});

test("DELETE /projects/:id marks the project for deletion", async () => {
  const { projects } = (await (await fetch(`${baseUrl}/projects`)).json()) as ListProjectsResponse;
  const target = projects.find((project) => project.name === "third")!;
  const response = await fetch(`${baseUrl}/projects/${target.id}`, { method: "DELETE" });
  assert.equal(response.status, 202);
  const view = (await (await fetch(`${baseUrl}/projects/${target.id}`)).json()) as ProjectView;
  assert.equal(view.status, "deleting");
});

test("health endpoints report liveness and readiness", async () => {
  assert.equal((await fetch(`${baseUrl}/health/live`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);
  repository.available = false;
  try {
    const response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "not_ready",
      checks: { database: "unavailable" },
    });
  } finally {
    repository.available = true;
  }
});

test("unknown routes return 404 JSON", async () => {
  const response = await fetch(`${baseUrl}/jobs`);
  assert.equal(response.status, 404);
  assert.equal((await errorOf(response)).code, "NOT_FOUND");
});

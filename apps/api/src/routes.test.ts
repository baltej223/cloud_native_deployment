import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { ServiceSpec } from "@cloud-platform/contracts";
import { LocalRouter } from "@cloud-platform/drivers";
import { FakeRuntime } from "@cloud-platform/drivers/testing";
import { createLogger } from "@cloud-platform/platform";
import { InMemoryProjectRepository } from "@cloud-platform/platform/testing";
import { createApp } from "./app.js";
import { ProjectsService } from "./projects-service.js";

const logger = createLogger("routes-test", "silent");
const repository = new InMemoryProjectRepository();
const domain = "cloud.example.com";
let baseUrl = "";
let close: () => void;
let id = "";

const service = (name: string, httpPort: number | null): ServiceSpec => ({
  name,
  image: `${name}:1`,
  pull: true,
  command: null,
  entrypoint: null,
  env: {},
  volumes: [],
  tmpVolumes: [],
  workingDir: null,
  user: null,
  restart: "no",
  dependsOn: [],
  httpPort,
});

before(async () => {
  const limits = { portRange: { min: 8001, max: 8010 }, maxProjects: 10 };
  const { project, deployment } = await repository.create(
    {
      name: "shop",
      source: { type: "repo", repoUrl: "https://github.com/acme/shop" },
      containerPort: null,
      healthCheckPath: "/",
      env: {},
    },
    limits,
  );
  id = project.id;
  await repository.transition(deployment.id, "pending", "building");
  await repository.transition(deployment.id, "building", "deploying", {
    imageRef: "x",
    containerPort: 3000,
    compose: {
      file: "compose.yaml",
      publicService: "web",
      services: [service("db", null), service("adminer", 8080), service("web", 3000)],
    },
  });
  await repository.transition(deployment.id, "deploying", "live");

  const router = new LocalRouter({ publicHost: "localhost", probeVia: "host", appDomain: domain });
  const app = createApp({
    projects: new ProjectsService(repository, router, new FakeRuntime(), limits, logger),
    logger,
    allowedOrigins: [],
    readinessChecks: {},
    auth: { password: "secret", secureCookie: true },
    routing: { repository, domain },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const resolve = (host: string) =>
  fetch(`${baseUrl}/routes/resolve`, { headers: { "x-forwarded-host": host } });

test("hosts resolve to the app and to services that publish ports", async () => {
  let response = await resolve("shop.cloud.example.com");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-cp-upstream"), `cp-app-${id}:3000`);

  response = await resolve("adminer.shop.cloud.example.com");
  assert.equal(response.headers.get("x-cp-upstream"), `cp-app-${id}-adminer:8080`);

  assert.equal((await resolve("db.shop.cloud.example.com")).status, 404, "no ports: no URL");
  assert.equal((await resolve("other.cloud.example.com")).status, 404);
  assert.equal((await resolve("shop.evil.test")).status, 404);
});

test("certificates are only allowed for known names", async () => {
  const check = (name: string) => fetch(`${baseUrl}/routes/check?domain=${name}`);
  assert.equal((await check("adminer.shop.cloud.example.com")).status, 200);
  assert.equal((await check("random.cloud.example.com")).status, 404);
});

test("stopped apps answer 503", async () => {
  await repository.setDesiredState(id, "stopped", "user");
  await new Promise((resolve) => setTimeout(resolve, 3_100));
  assert.equal((await resolve("shop.cloud.example.com")).status, 503);
});

test("the project view lists HTTPS URLs", async () => {
  const project = await repository.get(id);
  const view = new ProjectsService(
    repository,
    new LocalRouter({ publicHost: "localhost", probeVia: "host", appDomain: domain }),
    new FakeRuntime(),
    { portRange: { min: 8001, max: 8010 }, maxProjects: 10 },
    logger,
  ).toView(project!);
  assert.equal(view.url, "https://shop.cloud.example.com");
  assert.deepEqual(view.serviceUrls, { adminer: "https://adminer.shop.cloud.example.com" });
});

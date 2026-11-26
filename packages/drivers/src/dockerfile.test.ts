import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  chooseDockerfile,
  dockerignoreExcludes,
  findDockerfiles,
  parseExposedPort,
} from "./dockerfile.js";
import { DeployError } from "./types.js";

const roots: string[] = [];
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function repo(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dockerfile-test-"));
  roots.push(root);
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "FROM scratch\n");
  }
  return root;
}

const URL = "https://github.com/acme/app";

test("a root Dockerfile is found and chosen", async () => {
  const root = await repo(["Dockerfile", "README.md", "services/api/Dockerfile"]);
  const found = await findDockerfiles(root);
  assert.deepEqual(found, ["Dockerfile", "services/api/Dockerfile"]);
  assert.equal(chooseDockerfile(found, URL), "Dockerfile");
});

test("a single Dockerfile in a subfolder is chosen without being named", async () => {
  const root = await repo(["backend/Dockerfile", "backend/main.py"]);
  assert.equal(chooseDockerfile(await findDockerfiles(root), URL), "backend/Dockerfile");
});

test("Containerfile counts as a Dockerfile", async () => {
  const root = await repo(["Containerfile"]);
  assert.equal(chooseDockerfile(await findDockerfiles(root), URL), "Containerfile");
});

test("dependency, test and hidden folders are skipped", async () => {
  const root = await repo([
    "app/Dockerfile",
    "node_modules/some-lib/Dockerfile",
    "tests/fixtures/Dockerfile",
    ".devcontainer/Dockerfile",
    "vendor/x/Dockerfile",
  ]);
  assert.deepEqual(await findDockerfiles(root), ["app/Dockerfile"]);
});

test("the search stops three folders deep", async () => {
  const root = await repo(["a/b/c/Dockerfile", "a/b/c/d/Dockerfile"]);
  assert.deepEqual(await findDockerfiles(root), ["a/b/c/Dockerfile"]);
});

test("symbolic links are not followed", async () => {
  const root = await repo(["real/Dockerfile"]);
  await symlink(join(root, "real"), join(root, "linked"));
  assert.deepEqual(await findDockerfiles(root), ["real/Dockerfile"]);
});

test("several Dockerfiles without a root one fail and list the candidates", async () => {
  const root = await repo(["web/Dockerfile", "api/Dockerfile"]);
  assert.throws(
    () => chooseDockerfile(["api/Dockerfile", "web/Dockerfile"], URL),
    (error: unknown) =>
      error instanceof DeployError &&
      /api\/Dockerfile, web\/Dockerfile/.test(error.reason) &&
      /Dockerfile path setting/.test(error.reason),
  );
  assert.equal((await findDockerfiles(root)).length, 2);
});

test("a repository without a Dockerfile fails clearly", () => {
  assert.throws(
    () => chooseDockerfile([], URL),
    (error: unknown) => error instanceof DeployError && /No Dockerfile found/.test(error.reason),
  );
});

test("EXPOSE is read from the final stage", () => {
  assert.equal(parseExposedPort("FROM node:22\nEXPOSE 3000\nCMD node server.js"), 3000);
  assert.equal(parseExposedPort("FROM nginx\nEXPOSE 80/tcp 443"), 80);
  assert.equal(
    parseExposedPort(
      "FROM node AS build\nEXPOSE 9999\nRUN npm ci\n\nFROM nginx:alpine\nEXPOSE 8080",
    ),
    8080,
  );
  assert.equal(parseExposedPort("FROM node AS build\nEXPOSE 9999\nFROM nginx:alpine\n"), null);
  assert.equal(parseExposedPort("FROM python:3.12\nCMD python app.py"), null);
});

test("EXPOSE variables resolve from ARG and ENV defaults", () => {
  assert.equal(parseExposedPort("FROM node\nENV PORT=5000\nEXPOSE $PORT"), 5000);
  assert.equal(parseExposedPort("FROM node\nARG APP_PORT=7000\nEXPOSE ${APP_PORT}"), 7000);
  assert.equal(parseExposedPort("FROM node\nENV PORT 4000\nEXPOSE ${PORT}"), 4000);
  assert.equal(parseExposedPort("FROM node\nEXPOSE ${UNSET:-8000}"), 8000);
  assert.equal(parseExposedPort("FROM node\nEXPOSE $UNSET"), null);
});

test("comments, lower case and line continuations are handled", () => {
  assert.equal(parseExposedPort("# EXPOSE 1\nfrom node\nexpose \\\n  5173"), 5173);
});

test(".dockerignore becomes tar excludes", () => {
  assert.deepEqual(
    dockerignoreExcludes("# deps\nnode_modules\n/dist/\n**/*.log\n!keep.log\n\n.env\nDockerfile\n"),
    ["node_modules", "dist", "*.log", ".env"],
  );
});

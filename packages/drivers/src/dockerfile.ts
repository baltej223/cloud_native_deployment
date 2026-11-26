import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { DeployError } from "./types.js";

/** File names recognised as a Dockerfile. */
export const DOCKERFILE_NAMES = ["Dockerfile", "Containerfile", "dockerfile"] as const;

/** Folders that never hold the app's own Dockerfile. */
export const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".github",
  "node_modules",
  "vendor",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "testdata",
  "e2e",
]);

/** How deep below the repository root to look. */
export const MAX_SEARCH_DEPTH = 3;

/**
 * All Dockerfiles in the repository, as POSIX paths relative to the root,
 * shallowest first. Symbolic links are ignored so a repository cannot point
 * the build outside itself.
 */
export async function findDockerfiles(
  root: string,
  maxDepth = MAX_SEARCH_DEPTH,
): Promise<string[]> {
  const found: Array<{ path: string; depth: number }> = [];

  async function walk(relative: string, depth: number): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative ? posix.join(relative, entry.name) : entry.name;
      if (entry.isFile() && (DOCKERFILE_NAMES as readonly string[]).includes(entry.name)) {
        found.push({ path, depth });
      } else if (
        entry.isDirectory() &&
        depth < maxDepth &&
        !SKIPPED_DIRECTORIES.has(entry.name) &&
        !entry.name.startsWith(".")
      ) {
        await walk(path, depth + 1);
      }
    }
  }

  await walk("", 0);
  return found
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

/**
 * Pick the Dockerfile to build:
 * - one at the root wins (Dockerfile before Containerfile);
 * - otherwise exactly one candidate is used;
 * - several candidates, or none, fail with a message the user can act on.
 */
export function chooseDockerfile(candidates: string[], repoUrl: string): string {
  const atRoot = DOCKERFILE_NAMES.find((name) => candidates.includes(name));
  if (atRoot) return atRoot;
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new DeployError(
      `No Dockerfile found in ${repoUrl} (looked in the root and up to ${MAX_SEARCH_DEPTH} folders deep). Add a Dockerfile to the repository.`,
    );
  }
  const listed = candidates.slice(0, 10).join(", ");
  const more = candidates.length > 10 ? ` and ${candidates.length - 10} more` : "";
  throw new DeployError(
    `Found several Dockerfiles: ${listed}${more}. Choose one with the Dockerfile path setting and deploy again.`,
  );
}

/** Join backslash-continued lines and drop comments. */
function instructions(content: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!current && (line.startsWith("#") || line === "")) continue;
    if (line.endsWith("\\")) {
      current += `${line.slice(0, -1)} `;
      continue;
    }
    lines.push((current + line).trim());
    current = "";
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

/**
 * The first port exposed by the final build stage, or null. Variables are
 * resolved from ARG and ENV defaults earlier in the same stage.
 */
export function parseExposedPort(content: string): number | null {
  const variables = new Map<string, string>();
  let port: number | null = null;

  const expand = (value: string) =>
    value.replace(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}?/g,
      (_, name: string, fallback?: string) => variables.get(name) ?? fallback ?? "",
    );

  for (const line of instructions(content)) {
    const match = /^(\w+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const keyword = match[1]!.toUpperCase();
    const rest = match[2]!.trim();

    if (keyword === "FROM") {
      // A new stage: only the final stage's EXPOSE counts.
      variables.clear();
      port = null;
    } else if (keyword === "ARG" || keyword === "ENV") {
      // ARG NAME=value | ENV NAME=value [NAME2=value2] | ENV NAME value
      const pairs = rest.match(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g);
      if (pairs) {
        for (const pair of pairs) {
          const [name, ...value] = pair.split("=");
          variables.set(name!, expand(value.join("=").replace(/^["']|["']$/g, "")));
        }
      } else if (keyword === "ENV") {
        const [name, ...value] = rest.split(/\s+/);
        if (name) variables.set(name, expand(value.join(" ")));
      }
    } else if (keyword === "EXPOSE" && port === null) {
      for (const token of expand(rest).split(/\s+/)) {
        const number = Number(token.split("/")[0]);
        if (Number.isInteger(number) && number >= 1 && number <= 65_535) {
          port = number;
          break;
        }
      }
    }
  }
  return port;
}

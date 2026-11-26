import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { Transform } from "node:stream";
import {
  chooseDockerfile,
  dockerignoreExcludes,
  findDockerfiles,
  parseExposedPort,
} from "./dockerfile.js";
import { DockerEngine } from "./docker-engine.js";
import {
  appName,
  DeployError,
  type BuildRequest,
  type BuildResult,
  type Builder,
} from "./types.js";

export interface LocalBuilderOptions {
  /** Docker or Podman API socket that runs the build. */
  socketPath: string;
  /** Directory for temporary clones; each build gets its own folder, removed afterwards. */
  workDir: string;
  cloneTimeoutMs?: number;
  /** Largest build context the platform sends to the engine. */
  maxContextBytes?: number;
}

const DEFAULT_MAX_CONTEXT_BYTES = 500 * 1024 * 1024;

function shorten(message: string, max = 300): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Run a command, streaming its output to `onOutput`. Resolves with stdout. */
function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    signal: AbortSignal;
    timeoutMs: number;
    onOutput?: (text: string) => void;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        // Never prompt for credentials: private repositories must fail, not hang.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      options.onOutput?.(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      options.onOutput?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          Object.assign(new Error(stderr || `${command} exited with ${code ?? signal}`), {
            stderr,
          }),
        );
    });
  });
}

/**
 * Builds repositories on the local Docker or Podman engine:
 * shallow clone → find the Dockerfile → read EXPOSE → send the context to the
 * engine's build API → tag the image for the deployment.
 */
export class LocalBuilder implements Builder {
  private readonly engine: DockerEngine;

  constructor(private readonly options: LocalBuilderOptions) {
    this.engine = new DockerEngine(options.socketPath);
  }

  async build(request: BuildRequest): Promise<BuildResult> {
    const { repoUrl, branch, signal, onLog } = request;
    await mkdir(this.options.workDir, { recursive: true });
    const workDir = await mkdtemp(join(this.options.workDir, "build-"));
    const source = join(workDir, "src");

    try {
      // 1. Clone.
      onLog(`==> Cloning ${repoUrl}${branch ? ` (branch ${branch})` : ""}\n`);
      try {
        await run(
          "git",
          [
            "-c",
            "credential.helper=",
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--no-tags",
            ...(branch ? ["--branch", branch] : []),
            "--",
            repoUrl,
            source,
          ],
          { signal, timeoutMs: this.options.cloneTimeoutMs ?? 120_000, onOutput: onLog },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const message = (error as { stderr?: string }).stderr ?? String(error);
        if (/Remote branch .* not found/i.test(message)) {
          throw new DeployError(`Branch ${branch} does not exist in ${repoUrl}.`);
        }
        if (
          /not found|could not read Username|Authentication failed|terminal prompts disabled/i.test(
            message,
          )
        ) {
          throw new DeployError(`Repository ${repoUrl} was not found, or it is private.`);
        }
        throw new DeployError(`Could not clone ${repoUrl}: ${shorten(message)}`);
      }
      const commitSha = (
        await run("git", ["rev-parse", "HEAD"], { cwd: source, signal, timeoutMs: 10_000 })
      ).trim();
      onLog(`==> Commit ${commitSha}\n`);

      // 2. Find the Dockerfile.
      const dockerfilePath = request.dockerfilePath
        ? await this.checkDockerfile(source, request.dockerfilePath)
        : chooseDockerfile(await findDockerfiles(source), repoUrl);
      const contextPath = posix.dirname(dockerfilePath);
      const dockerfileName = posix.basename(dockerfilePath);
      const contextDir = join(source, ...contextPath.split("/"));
      onLog(
        `==> Using ${dockerfilePath}${request.dockerfilePath ? "" : " (found automatically)"}, build context ${contextPath === "." ? "the repository root" : contextPath}\n`,
      );

      // 3. Read the port.
      const exposedPort = parseExposedPort(await readFile(join(source, dockerfilePath), "utf8"));
      onLog(
        exposedPort
          ? `==> Dockerfile exposes port ${exposedPort}\n`
          : "==> Dockerfile has no EXPOSE instruction\n",
      );

      // 4. Build.
      const image = `localhost/${appName(request.projectId)}:${request.deploymentId.slice(0, 12)}`;
      onLog(`==> Building image ${image}\n`);
      await this.buildContext(contextDir, dockerfileName, image, signal, onLog);
      onLog(`==> Built ${image}\n`);

      return { image, commitSha, dockerfilePath, contextPath, exposedPort };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** A user-chosen Dockerfile must exist and stay inside the repository. */
  private async checkDockerfile(source: string, path: string): Promise<string> {
    const normalized = posix.normalize(path).replace(/^\.\//, "");
    const absolute = join(source, ...normalized.split("/"));
    try {
      const [real, root] = await Promise.all([realpath(absolute), realpath(source)]);
      const inside = relative(root, real);
      if (inside.startsWith("..") || inside.split(sep).includes("..")) throw new Error("outside");
      if (!(await stat(real)).isFile()) throw new Error("not a file");
    } catch {
      throw new DeployError(`Dockerfile ${normalized} does not exist in the repository.`);
    }
    return normalized;
  }

  private async buildContext(
    contextDir: string,
    dockerfile: string,
    tag: string,
    signal: AbortSignal,
    onLog: (text: string) => void,
  ): Promise<void> {
    let excludes: string[] = [];
    try {
      excludes = dockerignoreExcludes(await readFile(join(contextDir, ".dockerignore"), "utf8"));
    } catch {
      // No .dockerignore.
    }

    const tar = spawn(
      "tar",
      [
        "-c",
        "--exclude=.git",
        ...excludes.map((pattern) => `--exclude=${pattern}`),
        "-C",
        contextDir,
        ".",
      ],
      { signal, stdio: ["ignore", "pipe", "pipe"] },
    );
    let tarError = "";
    tar.stderr.setEncoding("utf8").on("data", (chunk: string) => (tarError += chunk));
    tar.on("error", () => {});

    // Stop sending once the context is too large.
    const limit = this.options.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit) {
          callback(
            new DeployError(
              `The build context is larger than ${Math.round(limit / 1024 / 1024)} MB. Add a .dockerignore file.`,
            ),
          );
        } else {
          callback(null, chunk);
        }
      },
    });
    tar.stdout.pipe(counter);

    try {
      await this.engine.build(counter, { tag, dockerfile, signal }, onLog);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof DeployError) throw error;
      if (tarError)
        throw new DeployError(`Could not package the build context: ${shorten(tarError)}`);
      const message = error instanceof Error ? error.message : String(error);
      throw new DeployError(`The build failed: ${shorten(message)} See the build log for details.`);
    }
  }
}

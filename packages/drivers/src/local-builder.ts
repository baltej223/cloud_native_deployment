import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import {
  choosePublicService,
  COMPOSE_FILE_NAMES,
  DEFAULT_MAX_COMPOSE_SERVICES,
  parseCompose,
} from "./compose.js";
import { chooseDockerfile, findDockerfiles, parseExposedPort } from "./dockerfile.js";
import { DockerEngine } from "./docker-engine.js";
import {
  appName,
  DeployError,
  type BuildRequest,
  type BuildResult,
  type Builder,
  type ServiceSpec,
} from "./types.js";

export interface LocalBuilderOptions {
  /** Docker or Podman API socket that runs the build. */
  socketPath: string;
  /** Directory for temporary clones; each build gets its own folder, removed afterwards. */
  workDir: string;
  cloneTimeoutMs?: number;
  /** Largest build context the platform sends to the engine. */
  maxContextBytes?: number;
  /** Most services a compose file may start. */
  maxComposeServices?: number;
}

interface BuildOptions {
  args?: Record<string, string>;
  target?: string | null;
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
    env?: Record<string, string>;
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
        ...options.env,
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

      // 2. A compose file at the root wins, unless the user chose a Dockerfile.
      if (!request.dockerfilePath) {
        const composeFile = await this.findComposeFile(source);
        if (composeFile) return await this.buildCompose(request, source, composeFile, commitSha);
      }

      // 3. Find the Dockerfile.
      const dockerfilePath = request.dockerfilePath
        ? await this.checkDockerfile(source, request.dockerfilePath)
        : chooseDockerfile(await findDockerfiles(source), repoUrl);
      const contextPath = posix.dirname(dockerfilePath);
      const dockerfileName = posix.basename(dockerfilePath);
      const contextDir = join(source, ...contextPath.split("/"));
      onLog(
        `==> Using ${dockerfilePath}${request.dockerfilePath ? "" : " (found automatically)"}, build context ${contextPath === "." ? "the repository root" : contextPath}\n`,
      );

      // 4. Read the port.
      const exposedPort = parseExposedPort(await readFile(join(source, dockerfilePath), "utf8"));
      onLog(
        exposedPort
          ? `==> Dockerfile exposes port ${exposedPort}\n`
          : "==> Dockerfile has no EXPOSE instruction\n",
      );

      // 5. Build.
      const image = `localhost/${appName(request.projectId)}:${request.deploymentId.slice(0, 12)}`;
      onLog(`==> Building image ${image}\n`);
      await this.buildContext(contextDir, dockerfileName, image, signal, onLog);
      onLog(`==> Built ${image}\n`);

      return { image, commitSha, dockerfilePath, contextPath, exposedPort };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The first compose file at the repository root that is a regular file. */
  private async findComposeFile(source: string): Promise<string | null> {
    for (const name of COMPOSE_FILE_NAMES) {
      try {
        if ((await lstat(join(source, name))).isFile()) return name;
      } catch {
        // Not there.
      }
    }
    return null;
  }

  /** Read a repository file without following links out of the repository. */
  private readRepoFile(source: string, path: string): string | null {
    try {
      const root = realpathSync(source);
      const real = realpathSync(join(source, ...path.split("/")));
      const inside = relative(root, real);
      if (inside.startsWith("..") || inside.split(sep).includes("..")) return null;
      if (!statSync(real).isFile()) return null;
      return readFileSync(real, "utf8");
    } catch {
      return null;
    }
  }

  /** Build every service of a compose file that has a build section. */
  private async buildCompose(
    request: BuildRequest,
    source: string,
    file: string,
    commitSha: string,
  ): Promise<BuildResult> {
    const { signal, onLog } = request;
    onLog(`==> Using ${file} (found at the repository root)\n`);
    const parsed = parseCompose(await readFile(join(source, file), "utf8"), {
      file,
      env: request.env,
      readFile: (path) => this.readRepoFile(source, path),
      maxServices: this.options.maxComposeServices ?? DEFAULT_MAX_COMPOSE_SERVICES,
    });
    for (const warning of parsed.warnings) onLog(`==> Note: ${warning}\n`);
    const publicService = choosePublicService(parsed, file, request.composeService);
    onLog(
      `==> Services: ${parsed.services.map((service) => service.name).join(", ")}; ${publicService.name} gets the URL\n`,
    );

    let exposedPort = publicService.port;
    const services: ServiceSpec[] = [];
    for (const service of parsed.services) {
      const { build, publishes, port, image: pulled, copies, ...fields } = service;
      const rest = { ...fields, httpPort: publishes ? port : null };
      const image = `localhost/${appName(request.projectId)}-${service.name.toLowerCase()}:${request.deploymentId.slice(0, 12)}`;
      if (!build) {
        onLog(`==> Service ${service.name} uses image ${pulled}\n`);
        if (copies.length === 0) {
          services.push({ ...rest, image: pulled!, pull: true });
          continue;
        }
        await this.addCopies(source, pulled!, image, copies, request);
        services.push({ ...rest, image, pull: false });
        continue;
      }
      const dockerfilePath = await this.checkDockerfile(
        source,
        posix.join(build.context, build.dockerfile),
      );
      const contextDir = await this.checkContext(source, build.context);
      onLog(
        `==> Building service ${service.name} from ${dockerfilePath} (context ${build.context === "." ? "the repository root" : build.context})\n`,
      );
      await this.buildContext(contextDir, build.dockerfile, image, signal, onLog, build);
      onLog(`==> Built ${image}\n`);
      if (service === publicService && exposedPort === null) {
        exposedPort = parseExposedPort(await readFile(join(source, dockerfilePath), "utf8"));
      }
      if (copies.length) await this.addCopies(source, image, image, copies, request);
      services.push({ ...rest, image, pull: false });
    }
    if (exposedPort) onLog(`==> Service ${publicService.name} listens on port ${exposedPort}\n`);

    const publicSpec = services.find((service) => service.name === publicService.name)!;
    return {
      image: publicSpec.image,
      commitSha,
      dockerfilePath: file,
      contextPath: ".",
      exposedPort,
      compose: { file, publicService: publicService.name, services },
    };
  }

  /**
   * Bake folders a service mounts from the repository into its image: build
   * `FROM base` + `COPY` on top, tagged `tag`.
   */
  private async addCopies(
    source: string,
    base: string,
    tag: string,
    copies: Array<{ source: string; target: string }>,
    request: BuildRequest,
  ): Promise<void> {
    const { signal, onLog } = request;
    const contextDir = await mkdtemp(join(this.options.workDir, "copies-"));
    try {
      const lines = [`FROM ${base}`];
      for (const [index, copy] of copies.entries()) {
        const from = await this.checkRepoPath(source, copy.source);
        await cp(from, join(contextDir, `c${index}`), {
          recursive: true,
          // Links are copied as links, never followed out of the repository.
          verbatimSymlinks: true,
          filter: (path) => !path.split(sep).includes(".git"),
        });
        lines.push(`COPY c${index} ${JSON.stringify(copy.target)}`);
        onLog(`==> Copying ${copy.source} to ${copy.target} (mounted in the compose file)\n`);
      }
      await writeFile(join(contextDir, "Dockerfile"), `${lines.join("\n")}\n`);
      await this.buildContext(contextDir, "Dockerfile", tag, signal, onLog);
    } finally {
      await rm(contextDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** A file or folder inside the repository, links resolved. */
  private async checkRepoPath(source: string, path: string): Promise<string> {
    try {
      const [real, root] = await Promise.all([
        realpath(join(source, ...path.split("/"))),
        realpath(source),
      ]);
      const inside = relative(root, real);
      if (inside.startsWith("..") || inside.split(sep).includes("..")) throw new Error("outside");
      return real;
    } catch {
      throw new DeployError(`The folder ${path} mounted in the compose file does not exist.`);
    }
  }

  /** A build context must be a folder inside the repository. */
  private async checkContext(source: string, path: string): Promise<string> {
    const absolute = join(source, ...path.split("/"));
    try {
      const [real, root] = await Promise.all([realpath(absolute), realpath(source)]);
      const inside = relative(root, real);
      if (inside.startsWith("..") || inside.split(sep).includes("..")) throw new Error("outside");
      if (!(await stat(real)).isDirectory()) throw new Error("not a folder");
      return real;
    } catch {
      throw new DeployError(`The build context ${path} does not exist in the repository.`);
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

  /**
   * Build with BuildKit (`docker buildx build`), like `docker build` does
   * today: .dockerignore, `FROM --platform=$BUILDPLATFORM`, `RUN --mount` and
   * other modern Dockerfile features work. The engine's own /build endpoint
   * uses the legacy builder, which supports none of them.
   */
  private async buildContext(
    contextDir: string,
    dockerfile: string,
    tag: string,
    signal: AbortSignal,
    onLog: (text: string) => void,
    options: BuildOptions = {},
  ): Promise<void> {
    // Refuse huge contexts before sending them (.git excluded; .dockerignore
    // is applied by BuildKit, so this count is an upper bound).
    const limit = this.options.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
    const size = Number(
      (await run("du", ["-sb", "--exclude=.git", contextDir], { signal, timeoutMs: 60_000 })).split(
        /\s/,
      )[0],
    );
    if (size > limit) {
      throw new DeployError(
        `The build context is larger than ${Math.round(limit / 1024 / 1024)} MB. Add a .dockerignore file.`,
      );
    }

    const args = [
      "buildx",
      "build",
      "--load",
      "--progress=plain",
      "--tag",
      tag,
      "--file",
      join(contextDir, ...dockerfile.split("/")),
      ...Object.entries(options.args ?? {}).flatMap(([key, value]) => [
        "--build-arg",
        `${key}=${value}`,
      ]),
      ...(options.target ? ["--target", options.target] : []),
      contextDir,
    ];
    let output = "";
    try {
      await run("docker", args, {
        signal,
        timeoutMs: 24 * 60 * 60_000, // the build timeout comes from `signal`
        env: { DOCKER_HOST: `unix://${this.options.socketPath}`, DOCKER_CLI_HINTS: "false" },
        onOutput: (text) => {
          output = (output + text).slice(-8_192);
          onLog(text);
        },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      // BuildKit ends a failed build with "ERROR: failed to build: …".
      const reason =
        output
          .split("\n")
          .reverse()
          .find((line) => /^ERROR:/.test(line.trim()))
          ?.replace(/^\s*ERROR:\s*/, "") ??
        (error instanceof Error ? error.message : String(error));
      throw new DeployError(`The build failed: ${shorten(reason)} See the build log for details.`);
    }
  }
}

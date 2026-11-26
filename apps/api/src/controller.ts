import { PORT_ENV_VAR } from "@cloud-platform/contracts";
import {
  DeployError,
  type AppSpec,
  type Builder,
  type Router,
  type Runtime,
} from "@cloud-platform/drivers";
import {
  BUILD_LOG_MAX_CHARS,
  errorSummary,
  type DeploymentRecord,
  type Logger,
  type ProjectRecord,
  type ProjectRepository,
} from "@cloud-platform/platform";

export interface ControllerOptions {
  intervalMs: number;
  /** How long a build (clone + docker build) may take. */
  buildTimeoutMs: number;
  /** How long a started app gets to pass its health check. */
  healthTimeoutMs: number;
  /** Upper bound for the deploy step, including pulling the image. */
  deployTimeoutMs: number;
  /** How often build output is saved while a build runs. */
  logFlushMs?: number;
  now?: () => number;
}

interface RunningBuild {
  projectId: string;
  abort: AbortController;
  done: Promise<void>;
}

/**
 * The deployment controller. Instead of a queue, it repeatedly compares the
 * desired state in the database with what is actually running, and takes the
 * next step for each project. Every step is safe to repeat, so a crash or
 * restart simply continues from the state recorded in the database.
 *
 *   pending   -> building    repository sources: clone, find the Dockerfile, build
 *   pending   -> deploying   image sources: nothing to build
 *   building  -> deploying   build finished; image, commit and port recorded
 *   deploying -> live        container started and answering its health check
 *   any       -> failed      with a reason the user can act on
 *
 * Builds run in the background (they take minutes); a build interrupted by a
 * restart is started again. When a new deployment fails, the previous live
 * version is started again so the URL keeps working.
 */
export class DeploymentController {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  /** Projects with a step in progress, so slow steps never overlap. */
  private readonly busy = new Set<string>();
  /** Builds in progress, by deployment ID. */
  private readonly builds = new Map<string, RunningBuild>();
  private readonly now: () => number;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly builder: Builder,
    private readonly runtime: Runtime,
    private readonly router: Router,
    private readonly logger: Logger,
    private readonly options: ControllerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    const loop = async () => {
      this.running = this.tick();
      await this.running;
      if (this.timer !== undefined) this.timer = setTimeout(loop, this.options.intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  /** Stop scheduling ticks, interrupt builds (they restart on the next start) and wait. */
  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const build of this.builds.values()) build.abort.abort();
    await Promise.all([this.running, ...[...this.builds.values()].map((build) => build.done)]);
  }

  /** Resolve once every build started so far has finished (for tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.builds.values()].map((build) => build.done));
  }

  /**
   * One pass over all outstanding work. Steps for different projects run in
   * parallel; a failing project never blocks the others.
   */
  async tick(): Promise<void> {
    let work;
    try {
      work = await this.repository.findWork();
    } catch (error) {
      this.logger.warn({ err: errorSummary(error) }, "controller could not load work");
      return;
    }
    await Promise.all([
      ...work.deletions.map((project) =>
        this.exclusive(project.id, () => this.removeProject(project)),
      ),
      ...work.deployments.map(({ project, deployment }) =>
        this.exclusive(project.id, () => this.advance(project, deployment)),
      ),
    ]);
  }

  private async exclusive(projectId: string, step: () => Promise<void>): Promise<void> {
    if (this.busy.has(projectId)) return;
    this.busy.add(projectId);
    try {
      await step();
    } catch (error) {
      this.logger.error(
        { projectId, err: errorSummary(error) },
        "controller step failed; will retry",
      );
    } finally {
      this.busy.delete(projectId);
    }
  }

  private async advance(project: ProjectRecord, deployment: DeploymentRecord): Promise<void> {
    const log = this.logger.child({ projectId: project.id, deploymentId: deployment.id });

    switch (deployment.status) {
      case "pending":
        if (project.source.type === "repo") {
          if (await this.repository.transition(deployment.id, "pending", "building")) {
            log.info({ repoUrl: project.source.repoUrl }, "deployment started; building");
          }
        } else if (
          await this.repository.transition(deployment.id, "pending", "deploying", {
            imageRef: project.source.image,
            ...(project.containerPort ? { containerPort: project.containerPort } : {}),
          })
        ) {
          log.info({ image: project.source.image }, "deployment started");
        }
        return;
      case "building":
        if (!this.builds.has(deployment.id)) this.startBuild(project, deployment, log);
        return;
      case "deploying":
        return this.deploying(project, deployment, log);
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Building
  // ---------------------------------------------------------------------------

  private startBuild(project: ProjectRecord, deployment: DeploymentRecord, log: Logger): void {
    if (project.source.type !== "repo") return;
    const source = project.source;
    const abort = new AbortController();
    const timeout = AbortSignal.timeout(this.options.buildTimeoutMs);
    const signal = AbortSignal.any([abort.signal, timeout]);

    let output = "";
    let dirty = false;
    const flush = async () => {
      if (!dirty) return;
      dirty = false;
      await this.repository.setBuildLog(deployment.id, output).catch((error) => {
        log.warn({ err: errorSummary(error) }, "could not save build log");
      });
    };
    const flusher = setInterval(() => void flush(), this.options.logFlushMs ?? 1_000);

    const fail = async (reason: string) => {
      output += `\n==> Failed: ${reason}\n`;
      dirty = true;
      if (
        await this.repository.transition(deployment.id, "building", "failed", {
          failureReason: reason,
        })
      ) {
        log.warn({ reason }, "build failed");
      }
    };

    const run = async () => {
      log.info({ repoUrl: source.repoUrl, branch: source.branch }, "build started");
      try {
        const result = await this.builder.build({
          projectId: project.id,
          deploymentId: deployment.id,
          repoUrl: source.repoUrl,
          branch: source.branch,
          dockerfilePath: source.dockerfilePath,
          signal,
          onLog: (text) => {
            output = (output + text).slice(-BUILD_LOG_MAX_CHARS);
            dirty = true;
          },
        });

        const port = project.containerPort ?? result.exposedPort;
        if (!port) {
          return await fail(
            `${result.dockerfilePath} has no EXPOSE instruction, so the port the app listens on is unknown. Set the container port and deploy again.`,
          );
        }
        output += `==> The app will listen on port ${port}${project.containerPort ? " (set by you)" : " (from EXPOSE)"}\n`;
        dirty = true;
        if (
          await this.repository.transition(deployment.id, "building", "deploying", {
            imageRef: result.image,
            commitSha: result.commitSha,
            dockerfilePath: result.dockerfilePath,
            contextPath: result.contextPath,
            containerPort: port,
          })
        ) {
          log.info(
            { image: result.image, commit: result.commitSha, dockerfile: result.dockerfilePath },
            "build finished",
          );
        }
      } catch (error) {
        if (timeout.aborted) {
          const minutes = Math.round(this.options.buildTimeoutMs / 60_000);
          await fail(`The build did not finish within ${minutes} min.`);
        } else if (abort.signal.aborted) {
          // Deleted or shutting down: a remaining deployment is rebuilt later.
          log.info("build interrupted");
        } else if (error instanceof DeployError) {
          await fail(error.reason);
        } else {
          log.error({ err: errorSummary(error) }, "build crashed");
          await fail(`The build failed unexpectedly: ${errorSummary(error)}`);
        }
      } finally {
        clearInterval(flusher);
        await flush();
        this.builds.delete(deployment.id);
      }
    };

    this.builds.set(deployment.id, { projectId: project.id, abort, done: run() });
  }

  // ---------------------------------------------------------------------------
  // Deploying
  // ---------------------------------------------------------------------------

  private appSpec(project: ProjectRecord, deployment: DeploymentRecord): AppSpec {
    const containerPort = deployment.containerPort ?? project.containerPort!;
    return {
      projectId: project.id,
      deploymentId: deployment.id,
      image: deployment.imageRef!,
      containerPort,
      // Apps that read $PORT listen where the platform expects; a user's PORT wins.
      env: { [PORT_ENV_VAR]: String(containerPort), ...project.env },
      publicPort: project.assignedPort,
      pull: project.source.type === "image",
    };
  }

  private async deploying(
    project: ProjectRecord,
    deployment: DeploymentRecord,
    log: Logger,
  ): Promise<void> {
    const spec = this.appSpec(project, deployment);

    const fail = async (reason: string) => {
      // Only remove the container if it runs this (broken) version.
      const state = await this.runtime.inspect(project.id);
      if (state.state !== "missing" && state.deploymentId === deployment.id) {
        await this.runtime.remove(project.id);
      }
      if (
        await this.repository.transition(deployment.id, "deploying", "failed", {
          failureReason: reason,
        })
      ) {
        log.warn({ reason }, "deployment failed");
        await this.restorePrevious(project, deployment, log);
      }
    };

    const deployStart = (deployment.deployStartedAt ?? deployment.createdAt).getTime();
    if (this.now() - deployStart > this.options.deployTimeoutMs) {
      const minutes = Math.round(this.options.deployTimeoutMs / 60_000);
      return fail(`The deployment did not finish within ${minutes} min.`);
    }

    const state = await this.runtime.inspect(project.id);

    if (state.state === "missing" || state.deploymentId !== deployment.id) {
      log.info({ image: spec.image, port: spec.containerPort }, "starting app");
      try {
        await this.runtime.deploy(spec);
      } catch (error) {
        if (error instanceof DeployError) return fail(error.reason);
        throw error;
      }
      return;
    }

    if (state.state === "exited" || state.state === "restarting" || state.restartCount > 0) {
      return fail(
        `The app exited${state.exitCode !== null ? ` with code ${state.exitCode}` : ""} right after starting. Check that the image runs on its own.`,
      );
    }

    if (state.state === "running") {
      const healthy = await this.router.probe({
        projectId: project.id,
        containerPort: spec.containerPort,
        publicPort: project.assignedPort,
        healthCheckPath: project.healthCheckPath,
      });
      if (healthy) {
        if (await this.repository.transition(deployment.id, "deploying", "live")) {
          log.info(
            { url: this.router.urlFor({ name: project.name, publicPort: project.assignedPort }) },
            "deployment live",
          );
        }
        return;
      }
    }

    // Count from the container's start, so a slow image pull does not use up the time.
    const startedAt = state.startedAt?.getTime() ?? deployStart;
    if (this.now() - startedAt > this.options.healthTimeoutMs) {
      const seconds = Math.round(this.options.healthTimeoutMs / 1000);
      return fail(
        `The app did not answer on port ${spec.containerPort} at ${project.healthCheckPath} within ${seconds} s. Check the container port.`,
      );
    }
  }

  /** After a failed deployment, start the version that was live before it. */
  private async restorePrevious(
    project: ProjectRecord,
    failed: DeploymentRecord,
    log: Logger,
  ): Promise<void> {
    const live = (await this.repository.get(project.id))?.live;
    if (!live || live.id === failed.id || !live.imageRef) return;
    try {
      await this.runtime.deploy({ ...this.appSpec(project, live), pull: false });
      log.info({ liveDeploymentId: live.id }, "previous version restored");
    } catch (error) {
      log.error(
        { liveDeploymentId: live.id, err: errorSummary(error) },
        "could not restore the previous version",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Deleting
  // ---------------------------------------------------------------------------

  private async removeProject(project: ProjectRecord): Promise<void> {
    for (const build of this.builds.values()) {
      if (build.projectId === project.id) build.abort.abort();
    }
    const images = (await this.repository.listDeployments(project.id, 1_000))
      .map((deployment) => deployment.imageRef)
      .filter((image): image is string => image !== null);
    await this.runtime.remove(project.id);
    if (project.source.type === "repo") {
      for (const image of new Set(images)) await this.runtime.removeImage(image);
    }
    await this.repository.remove(project.id);
    this.logger.info({ projectId: project.id, name: project.name }, "project deleted");
  }
}

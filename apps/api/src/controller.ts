import { DeployError, type Router, type Runtime } from "@cloud-platform/drivers";
import {
  errorSummary,
  type DeploymentRecord,
  type Logger,
  type ProjectRecord,
  type ProjectRepository,
} from "@cloud-platform/platform";

export interface ControllerOptions {
  intervalMs: number;
  /** How long a started app gets to pass its health check. */
  healthTimeoutMs: number;
  /** Upper bound for a whole deployment, including pulling the image. */
  deployTimeoutMs: number;
  now?: () => number;
}

/**
 * The deployment controller. Instead of a queue, it repeatedly compares the
 * desired state in the database with what is actually running, and takes the
 * next step for each project. Every step is safe to repeat, so a crash or
 * restart simply continues from the state recorded in the database.
 *
 * Deployment steps (Phase 1, image sources):
 *   pending   -> deploying   record the image to run
 *   deploying -> (deploy)    pull the image and start the container
 *   deploying -> live        once the app answers its health check
 *   deploying -> failed      pull/start error, crash, or health check timeout
 */
export class DeploymentController {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  /** Projects with a step in progress, so slow steps never overlap. */
  private readonly busy = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly repository: ProjectRepository,
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

  /** Stop scheduling ticks and wait for the current one to finish. */
  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
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
    const steps = [
      ...work.deletions.map((project) =>
        this.exclusive(project.id, () => this.removeProject(project)),
      ),
      ...work.deployments.map(({ project, deployment }) =>
        this.exclusive(project.id, () => this.advance(project, deployment)),
      ),
    ];
    await Promise.all(steps);
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
      case "pending": {
        // Image sources need no build; repository sources go through "building" (Phase 2).
        const image = project.source.image;
        if (
          await this.repository.transition(deployment.id, "pending", "deploying", {
            imageRef: image,
          })
        ) {
          log.info({ image }, "deployment started");
        }
        return;
      }
      case "deploying":
        return this.deploying(project, deployment, log);
      default:
        return;
    }
  }

  private async deploying(
    project: ProjectRecord,
    deployment: DeploymentRecord,
    log: Logger,
  ): Promise<void> {
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
      }
    };

    const deploymentStart = deployment.startedAt?.getTime() ?? deployment.createdAt.getTime();
    if (this.now() - deploymentStart > this.options.deployTimeoutMs) {
      const minutes = Math.round(this.options.deployTimeoutMs / 60_000);
      return fail(`The deployment did not finish within ${minutes} min.`);
    }

    const state = await this.runtime.inspect(project.id);

    if (state.state === "missing" || state.deploymentId !== deployment.id) {
      log.info({ image: deployment.imageRef }, "starting app");
      try {
        await this.runtime.deploy({
          projectId: project.id,
          deploymentId: deployment.id,
          image: deployment.imageRef ?? project.source.image,
          containerPort: project.containerPort,
          env: project.env,
          publicPort: project.assignedPort,
        });
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
        containerPort: project.containerPort,
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
    const startedAt = state.startedAt?.getTime() ?? deploymentStart;
    if (this.now() - startedAt > this.options.healthTimeoutMs) {
      const seconds = Math.round(this.options.healthTimeoutMs / 1000);
      return fail(
        `The app did not answer on port ${project.containerPort} at ${project.healthCheckPath} within ${seconds} s. Check the container port.`,
      );
    }
  }

  private async removeProject(project: ProjectRecord): Promise<void> {
    await this.runtime.remove(project.id);
    await this.repository.remove(project.id);
    this.logger.info({ projectId: project.id, name: project.name }, "project deleted");
  }
}

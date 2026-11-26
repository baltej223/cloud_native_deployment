import {
  appName,
  DeployError,
  type AppSpec,
  type AppState,
  type AppTarget,
  type Router,
  type Runtime,
} from "./types.js";

/** Scriptable Runtime for controller tests. */
export class FakeRuntime implements Runtime {
  readonly apps = new Map<string, { spec: AppSpec; state: AppState }>();
  readonly deployed: AppSpec[] = [];
  readonly removed: string[] = [];
  /** Images that fail to "pull". */
  readonly missingImages = new Set<string>();
  /** State a newly deployed app starts in. */
  initialState: "running" | "starting" | "exited" | "restarting" = "running";
  available = true;
  /** Clock used for container start times; tests can replace it. */
  clock: () => number = Date.now;

  async prepare(): Promise<void> {}

  async ping(): Promise<void> {
    if (!this.available) throw new Error("engine unavailable");
  }

  async deploy(spec: AppSpec): Promise<void> {
    if (this.missingImages.has(spec.image)) {
      throw new DeployError(`Image ${spec.image} was not found, or it is private.`);
    }
    this.deployed.push(spec);
    const crashed = this.initialState === "exited" || this.initialState === "restarting";
    this.apps.set(spec.projectId, {
      spec,
      state: {
        state: this.initialState,
        deploymentId: spec.deploymentId,
        exitCode: crashed ? 1 : null,
        restartCount: this.initialState === "restarting" ? 1 : 0,
        startedAt: this.initialState === "starting" ? null : new Date(this.clock()),
      },
    });
  }

  async inspect(projectId: string): Promise<AppState> {
    return this.apps.get(projectId)?.state ?? { state: "missing" };
  }

  async remove(projectId: string): Promise<void> {
    this.removed.push(projectId);
    this.apps.delete(projectId);
  }
}

/** Router whose apps are healthy unless listed in `unhealthy`. */
export class FakeRouter implements Router {
  readonly unhealthy = new Set<string>();

  urlFor(project: { name: string; publicPort: number }): string {
    return `http://apps.test:${project.publicPort}`;
  }

  async probe(target: AppTarget): Promise<boolean> {
    return !this.unhealthy.has(target.projectId);
  }
}

export { appName };

import {
  appName,
  type BuildRequest,
  type BuildResult,
  type Builder,
  DeployError,
  type AppSpec,
  type AppState,
  type AppTarget,
  type ComposePlan,
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

  readonly removedImages: string[] = [];

  async removeImage(image: string): Promise<void> {
    this.removedImages.push(image);
  }

  async remove(projectId: string): Promise<void> {
    this.removed.push(projectId);
    this.apps.delete(projectId);
  }

  readonly removedData: string[] = [];
  readonly stopped: string[] = [];
  readonly started: AppSpec[] = [];
  /** Bytes "received" per project; tests change it to simulate traffic. */
  readonly traffic = new Map<string, number>();
  /** Log text per project and service ("" = the public one). */
  readonly logLines = new Map<string, string>();

  async stop(projectId: string): Promise<void> {
    this.stopped.push(projectId);
    const app = this.apps.get(projectId);
    if (app && app.state.state !== "missing") {
      app.state = { ...app.state, state: "exited", exitCode: 0 };
    }
  }

  async start(spec: AppSpec): Promise<void> {
    this.started.push(spec);
    const app = this.apps.get(spec.projectId);
    if (!app || app.state.state === "missing" || app.state.deploymentId !== spec.deploymentId) {
      return this.deploy(spec);
    }
    app.state = {
      ...app.state,
      state: "running",
      exitCode: null,
      startedAt: new Date(this.clock()),
    };
  }

  async logs(projectId: string, service: string | null): Promise<string | null> {
    if (!this.apps.has(projectId)) return null;
    return this.logLines.get(`${projectId}/${service ?? ""}`) ?? null;
  }

  async receivedBytes(projectId: string): Promise<number | null> {
    const app = this.apps.get(projectId);
    if (!app || app.state.state !== "running") return null;
    return this.traffic.get(projectId) ?? 0;
  }

  async removeData(projectId: string): Promise<void> {
    this.removedData.push(projectId);
  }
}

/** Router whose apps are healthy unless listed in `unhealthy`. */
export class FakeRouter implements Router {
  readonly unhealthy = new Set<string>();

  urlFor(project: { name: string; publicPort: number }, service?: string): string {
    return service
      ? `http://${service}.${project.name}.apps.test`
      : `http://apps.test:${project.publicPort}`;
  }

  async probe(target: AppTarget): Promise<boolean> {
    return !this.unhealthy.has(target.projectId);
  }
}

/** Scriptable Builder for controller tests. Builds finish when `finish` is called. */
export class FakeBuilder implements Builder {
  readonly requests: BuildRequest[] = [];
  /** Port the fake Dockerfile exposes. */
  exposedPort: number | null = 3000;
  /** When set, builds "find" this compose plan. */
  compose: ComposePlan | null = null;
  /** When set, builds fail with this reason. */
  failWith: string | null = null;
  /** Builds wait until released, so tests can observe the "building" state. */
  autoFinish = true;
  private readonly waiting = new Map<string, () => void>();

  async build(request: BuildRequest): Promise<BuildResult> {
    this.requests.push(request);
    request.onLog("==> Cloning\n");
    if (!this.autoFinish) {
      await new Promise<void>((resolve, reject) => {
        this.waiting.set(request.deploymentId, resolve);
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }
    if (this.failWith) throw new DeployError(this.failWith);
    request.onLog("==> Built\n");
    return {
      image: `localhost/${appName(request.projectId)}:${request.deploymentId.slice(0, 12)}`,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      dockerfilePath: request.dockerfilePath ?? "Dockerfile",
      contextPath: ".",
      exposedPort: this.exposedPort,
      ...(this.compose ? { compose: this.compose } : {}),
    };
  }

  /** Let a waiting build complete. */
  finish(deploymentId: string): void {
    this.waiting.get(deploymentId)?.();
    this.waiting.delete(deploymentId);
  }
}

export { appName };

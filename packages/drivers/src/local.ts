import { DockerEngine, EngineError } from "./docker-engine.js";
import {
  appName,
  DeployError,
  LABELS,
  type AppSpec,
  type AppState,
  type AppTarget,
  type Router,
  type Runtime,
} from "./types.js";

export interface LocalRuntimeOptions {
  /** Docker or Podman API socket. */
  socketPath: string;
  /**
   * Network the app containers join. It is separate from the platform's own
   * network, so apps cannot reach the database or the API's internals.
   */
  network?: string;
  memoryMb: number;
  cpus: number;
  pullTimeoutMs?: number;
}

/** Keep engine messages short and on one line before showing them to users. */
function shorten(message: string, max = 300): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const PULL_NOT_FOUND =
  /not found|manifest unknown|pull access denied|unauthorized|access to the resource is denied|does not exist|name unknown/i;
const PORT_IN_USE = /address already in use|port is already allocated|bind/i;

/** Runs apps as containers on the local Docker or Podman engine. */
export class LocalRuntime implements Runtime {
  private readonly engine: DockerEngine;

  constructor(private readonly options: LocalRuntimeOptions) {
    this.engine = new DockerEngine(options.socketPath);
  }

  async prepare(): Promise<void> {
    if (this.options.network) await this.engine.ensureNetwork(this.options.network);
  }

  ping(): Promise<void> {
    return this.engine.ping();
  }

  async deploy(spec: AppSpec): Promise<void> {
    if (spec.pull) {
      try {
        await this.engine.pull(spec.image, this.options.pullTimeoutMs ?? 5 * 60_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (PULL_NOT_FOUND.test(message)) {
          throw new DeployError(`Image ${spec.image} was not found, or it is private.`);
        }
        throw new DeployError(`Could not pull image ${spec.image}: ${shorten(message)}`);
      }
    }

    const name = appName(spec.projectId);
    // Replace whatever version is running. Phase 1 accepts the short gap.
    await this.engine.removeContainer(name);

    const port = `${spec.containerPort}/tcp`;
    try {
      await this.engine.createContainer(name, {
        Image: spec.image,
        Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        ExposedPorts: { [port]: {} },
        Labels: { [LABELS.project]: spec.projectId, [LABELS.deployment]: spec.deploymentId },
        HostConfig: {
          PortBindings: { [port]: [{ HostIp: "", HostPort: String(spec.publicPort) }] },
          RestartPolicy: { Name: "unless-stopped" },
          Memory: this.options.memoryMb * 1024 * 1024,
          NanoCpus: Math.round(this.options.cpus * 1e9),
          ...(this.options.network ? { NetworkMode: this.options.network } : {}),
        },
      });
      await this.engine.startContainer(name);
    } catch (error) {
      await this.engine.removeContainer(name).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (PORT_IN_USE.test(message)) {
        throw new DeployError(
          `Port ${spec.publicPort} on the host is already in use by another program.`,
        );
      }
      if (error instanceof EngineError) {
        throw new DeployError(`Could not start the container: ${shorten(message)}`);
      }
      throw error;
    }
  }

  async inspect(projectId: string): Promise<AppState> {
    const container = await this.engine.inspectContainer(appName(projectId));
    if (!container) return { state: "missing" };
    const status = container.State.Status;
    const state =
      status === "running"
        ? "running"
        : status === "restarting"
          ? "restarting"
          : status === "created"
            ? "starting"
            : "exited";
    const startedAt = container.State.StartedAt ? new Date(container.State.StartedAt) : null;
    return {
      state,
      startedAt: startedAt && startedAt.getUTCFullYear() > 1970 ? startedAt : null,
      deploymentId: container.Config.Labels?.[LABELS.deployment] ?? null,
      exitCode: state === "exited" || state === "restarting" ? container.State.ExitCode : null,
      restartCount: container.RestartCount ?? 0,
    };
  }

  remove(projectId: string): Promise<void> {
    return this.engine.removeContainer(appName(projectId));
  }

  removeImage(image: string): Promise<void> {
    return this.engine.removeImage(image);
  }
}

export interface LocalRouterOptions {
  /** Host name in app URLs shown to users, e.g. localhost. */
  publicHost: string;
  /**
   * How the platform reaches apps for health checks:
   * - "network": by container name on the apps network (API in a container);
   * - "host": through the published port on `probeHost` (API on the host).
   */
  probeVia: "network" | "host";
  probeHost?: string;
  probeTimeoutMs?: number;
}

/** Apps are reached on their published host port. */
export class LocalRouter implements Router {
  constructor(private readonly options: LocalRouterOptions) {}

  urlFor(project: { name: string; publicPort: number }): string {
    return `http://${this.options.publicHost}:${project.publicPort}`;
  }

  async probe(target: AppTarget): Promise<boolean> {
    const base =
      this.options.probeVia === "network"
        ? `http://${appName(target.projectId)}:${target.containerPort}`
        : `http://${this.options.probeHost ?? "127.0.0.1"}:${target.publicPort}`;
    try {
      const response = await fetch(`${base}${target.healthCheckPath}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.probeTimeoutMs ?? 3_000),
      });
      await response.body?.cancel();
      return response.status < 500;
    } catch {
      return false;
    }
  }
}

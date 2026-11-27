import { DockerEngine, EngineError } from "./docker-engine.js";
import {
  appName,
  projectNetwork,
  serviceContainerName,
  volumeName,
  DeployError,
  LABELS,
  type AppSpec,
  type AppState,
  type AppTarget,
  type ComposePlan,
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
    const services = spec.compose?.services ?? [];
    const pulls = spec.compose
      ? services.filter((service) => service.pull).map((service) => service.image)
      : spec.pull
        ? [spec.image]
        : [];
    for (const image of new Set(pulls)) await this.pull(image);

    // Replace whatever version is running. Phase 1 accepts the short gap.
    await this.remove(spec.projectId);

    try {
      if (spec.compose) await this.startCompose(spec, spec.compose);
      else await this.startSingle(spec);
    } catch (error) {
      await this.remove(spec.projectId).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (PORT_IN_USE.test(message)) {
        throw new DeployError(
          `Port ${spec.publicPort} on the host is already in use by another program.`,
        );
      }
      if (error instanceof DeployError) throw error;
      if (error instanceof EngineError) {
        throw new DeployError(`Could not start the container: ${shorten(message)}`);
      }
      throw error;
    }
  }

  private async pull(image: string): Promise<void> {
    try {
      await this.engine.pull(image, this.options.pullTimeoutMs ?? 5 * 60_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (PULL_NOT_FOUND.test(message)) {
        throw new DeployError(`Image ${image} was not found, or it is private.`);
      }
      throw new DeployError(`Could not pull image ${image}: ${shorten(message)}`);
    }
  }

  private limits() {
    return {
      Memory: this.options.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(this.options.cpus * 1e9),
    };
  }

  private async startSingle(spec: AppSpec): Promise<void> {
    const name = appName(spec.projectId);
    const port = `${spec.containerPort}/tcp`;
    await this.engine.createContainer(name, {
      Image: spec.image,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      ExposedPorts: { [port]: {} },
      Labels: { [LABELS.project]: spec.projectId, [LABELS.deployment]: spec.deploymentId },
      HostConfig: {
        PortBindings: { [port]: [{ HostIp: "", HostPort: String(spec.publicPort) }] },
        RestartPolicy: { Name: "unless-stopped" },
        ...this.limits(),
        ...(this.options.network ? { NetworkMode: this.options.network } : {}),
      },
    });
    await this.engine.startContainer(name);
  }

  /**
   * Start a compose app: every service on a network private to the project,
   * reachable by its service name. Only the public service publishes a port
   * and joins the shared apps network (for health checks).
   */
  private async startCompose(spec: AppSpec, plan: ComposePlan): Promise<void> {
    const labels = { [LABELS.project]: spec.projectId };
    const network = projectNetwork(spec.projectId);
    await this.engine.ensureNetwork(network, labels);

    for (const service of plan.services) {
      const isPublic = service.name === plan.publicService;
      const name = isPublic
        ? appName(spec.projectId)
        : serviceContainerName(spec.projectId, service.name);
      for (const volume of service.volumes) {
        await this.engine.createVolume(volumeName(spec.projectId, volume.name), labels);
      }
      const port = `${spec.containerPort}/tcp`;
      const env = isPublic ? { ...service.env, ...spec.env } : service.env;
      await this.engine.createContainer(name, {
        Image: service.image,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        ...(service.command ? { Cmd: service.command } : {}),
        ...(service.entrypoint
          ? { Entrypoint: service.entrypoint.length ? service.entrypoint : [""] }
          : {}),
        ...(service.workingDir ? { WorkingDir: service.workingDir } : {}),
        ...(service.user ? { User: service.user } : {}),
        ...(isPublic ? { ExposedPorts: { [port]: {} } } : {}),
        Volumes: Object.fromEntries(service.tmpVolumes.map((path) => [path, {}])),
        Labels: {
          ...labels,
          [LABELS.deployment]: spec.deploymentId,
          [LABELS.service]: service.name,
        },
        HostConfig: {
          ...(isPublic
            ? { PortBindings: { [port]: [{ HostIp: "", HostPort: String(spec.publicPort) }] } }
            : {}),
          RestartPolicy:
            service.restart === "on-failure"
              ? { Name: "on-failure", MaximumRetryCount: 5 }
              : { Name: service.restart },
          ...this.limits(),
          NetworkMode: network,
          Binds: service.volumes.map(
            (volume) =>
              `${volumeName(spec.projectId, volume.name)}:${volume.target}${volume.readOnly ? ":ro" : ""}`,
          ),
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [service.name] } } },
      });
      if (isPublic && this.options.network) {
        await this.engine.connectNetwork(this.options.network, name, []);
      }
      await this.engine.startContainer(name);
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

  async remove(projectId: string): Promise<void> {
    const names = new Set(await this.engine.listContainers(`${LABELS.project}=${projectId}`));
    names.add(appName(projectId));
    for (const name of names) await this.engine.removeContainer(name);
  }

  /** Container names of a version, in start order (dependencies first). */
  private containerNames(spec: AppSpec): string[] {
    if (!spec.compose) return [appName(spec.projectId)];
    return spec.compose.services.map((service) =>
      service.name === spec.compose!.publicService
        ? appName(spec.projectId)
        : serviceContainerName(spec.projectId, service.name),
    );
  }

  async stop(projectId: string): Promise<void> {
    const names = await this.engine.listContainers(`${LABELS.project}=${projectId}`);
    // The public container first, so no request reaches a half-stopped app.
    const ordered = [appName(projectId), ...names.filter((name) => name !== appName(projectId))];
    for (const name of ordered) await this.engine.stopContainer(name);
  }

  async start(spec: AppSpec): Promise<void> {
    const names = this.containerNames(spec);
    const existing = await Promise.all(names.map((name) => this.engine.inspectContainer(name)));
    const sameVersion = existing.every(
      (container) => container?.Config.Labels?.[LABELS.deployment] === spec.deploymentId,
    );
    if (!sameVersion) return this.deploy({ ...spec, pull: false });
    try {
      for (const name of names) await this.engine.startContainer(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (PORT_IN_USE.test(message)) {
        throw new DeployError(
          `Port ${spec.publicPort} on the host is already in use by another program.`,
        );
      }
      throw error;
    }
  }

  async logs(projectId: string, service: string | null, tail: number): Promise<string | null> {
    const name = service ? serviceContainerName(projectId, service) : appName(projectId);
    // The public service of a compose app runs under the project's main name.
    const log = await this.engine.containerLogs(name, tail);
    if (log !== null || !service) return log;
    const main = await this.engine.inspectContainer(appName(projectId));
    return main?.Config.Labels?.[LABELS.service] === service
      ? this.engine.containerLogs(appName(projectId), tail)
      : null;
  }

  receivedBytes(projectId: string): Promise<number | null> {
    return this.engine.receivedBytes(appName(projectId));
  }

  async removeData(projectId: string): Promise<void> {
    for (const volume of await this.engine.listVolumes(`${LABELS.project}=${projectId}`)) {
      await this.engine.removeVolume(volume);
    }
    await this.engine.removeNetwork(projectNetwork(projectId));
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

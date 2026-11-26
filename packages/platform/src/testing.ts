import { randomUUID } from "node:crypto";
import {
  canTransition,
  isActiveDeployment,
  type DeploymentStatus,
} from "@cloud-platform/contracts";
import {
  BUILD_LOG_MAX_CHARS,
  DeploymentInProgressError,
  NameTakenError,
  NoFreePortError,
  ProjectLimitError,
  type ControllerWork,
  type DeploymentRecord,
  type NewProject,
  type ProjectLimits,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectWithLatest,
  type TransitionFields,
} from "./project-repository.js";

/** In-memory ProjectRepository with the same rules as the Postgres one, for tests. */
export class InMemoryProjectRepository implements ProjectRepository {
  readonly projects = new Map<string, ProjectRecord>();
  readonly deployments = new Map<string, DeploymentRecord>();
  readonly buildLogs = new Map<string, string>();
  available = true;
  /** Orders deployments created in the same millisecond. */
  private sequence = 0;
  private readonly order = new Map<string, number>();

  async ping(): Promise<void> {
    if (!this.available) throw new Error("database unavailable");
  }

  async create(input: NewProject, limits: ProjectLimits) {
    if (this.projects.size >= limits.maxProjects) throw new ProjectLimitError(limits.maxProjects);
    if ([...this.projects.values()].some((project) => project.name === input.name)) {
      throw new NameTakenError(input.name);
    }
    const used = new Set([...this.projects.values()].map((project) => project.assignedPort));
    let port: number | undefined;
    for (let candidate = limits.portRange.min; candidate <= limits.portRange.max; candidate++) {
      if (!used.has(candidate)) {
        port = candidate;
        break;
      }
    }
    if (port === undefined) throw new NoFreePortError();

    const now = this.now();
    const project: ProjectRecord = {
      id: randomUUID(),
      name: input.name,
      source: input.source,
      containerPort: input.containerPort,
      healthCheckPath: input.healthCheckPath,
      env: input.env,
      assignedPort: port,
      desiredState: "running",
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    const deployment = this.newDeployment(project.id);
    return { project: { ...project }, deployment: { ...deployment } };
  }

  async list(): Promise<ProjectWithLatest[]> {
    return [...this.projects.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((project) => this.withLatest(project));
  }

  async get(id: string): Promise<ProjectWithLatest | null> {
    const project = this.projects.get(id);
    return project ? this.withLatest(project) : null;
  }

  async markDeleted(id: string): Promise<boolean> {
    const project = this.projects.get(id);
    if (!project) return false;
    project.deletedAt ??= this.now();
    return true;
  }

  async createDeployment(projectId: string): Promise<DeploymentRecord | null> {
    const project = this.projects.get(projectId);
    if (!project || project.deletedAt) return null;
    if (this.deploymentsOf(projectId).some((d) => isActiveDeployment(d.status))) {
      throw new DeploymentInProgressError();
    }
    return { ...this.newDeployment(projectId) };
  }

  async listDeployments(projectId: string, limit = 20): Promise<DeploymentRecord[]> {
    return this.deploymentsOf(projectId)
      .slice(0, limit)
      .map((deployment) => ({ ...deployment }));
  }

  async getDeployment(id: string): Promise<DeploymentRecord | null> {
    const deployment = this.deployments.get(id);
    return deployment ? { ...deployment } : null;
  }

  async getBuildLog(id: string): Promise<string | null> {
    return this.deployments.has(id) ? (this.buildLogs.get(id) ?? "") : null;
  }

  async setBuildLog(id: string, log: string): Promise<void> {
    if (this.deployments.has(id)) this.buildLogs.set(id, log.slice(-BUILD_LOG_MAX_CHARS));
  }

  async findWork(): Promise<ControllerWork> {
    const deployments = this.sorted([...this.deployments.values()])
      .reverse()
      .filter((deployment) => isActiveDeployment(deployment.status))
      .map((deployment) => ({
        project: { ...this.projects.get(deployment.projectId)! },
        deployment: { ...deployment },
      }))
      .filter(({ project }) => project.deletedAt === null);
    const deletions = [...this.projects.values()]
      .filter((project) => project.deletedAt !== null)
      .map((project) => ({ ...project }));
    return { deployments, deletions };
  }

  async transition(
    id: string,
    from: DeploymentStatus,
    to: DeploymentStatus,
    fields: TransitionFields = {},
  ): Promise<DeploymentRecord | null> {
    if (!canTransition(from, to)) throw new Error(`invalid deployment transition ${from} -> ${to}`);
    const deployment = this.deployments.get(id);
    if (!deployment || deployment.status !== from) return null;
    const now = this.now();
    if (to === "live") {
      for (const other of this.deploymentsOf(deployment.projectId)) {
        if (other.status === "live" && other.id !== id) {
          other.status = "superseded";
          other.updatedAt = now;
        }
      }
    }
    if (from === "pending") deployment.startedAt ??= now;
    if (to === "deploying") deployment.deployStartedAt ??= now;
    if (to === "live" || to === "failed" || to === "cancelled") deployment.finishedAt ??= now;
    deployment.status = to;
    deployment.updatedAt = now;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (deployment as unknown as Record<string, unknown>)[key] = value;
    }
    return { ...deployment };
  }

  async remove(id: string): Promise<void> {
    this.projects.delete(id);
    for (const [deploymentId, deployment] of this.deployments) {
      if (deployment.projectId === id) {
        this.deployments.delete(deploymentId);
        this.buildLogs.delete(deploymentId);
      }
    }
  }

  /** Overridable clock, so tests can simulate time passing. */
  now(): Date {
    return new Date();
  }

  private newDeployment(projectId: string): DeploymentRecord {
    const now = this.now();
    const deployment: DeploymentRecord = {
      id: randomUUID(),
      projectId,
      status: "pending",
      imageRef: null,
      commitSha: null,
      dockerfilePath: null,
      contextPath: null,
      containerPort: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      deployStartedAt: null,
      finishedAt: null,
    };
    this.deployments.set(deployment.id, deployment);
    this.order.set(deployment.id, this.sequence++);
    return deployment;
  }

  /** Newest first. */
  private sorted(deployments: DeploymentRecord[]): DeploymentRecord[] {
    return deployments.sort((a, b) => this.order.get(b.id)! - this.order.get(a.id)!);
  }

  private deploymentsOf(projectId: string): DeploymentRecord[] {
    return this.sorted(
      [...this.deployments.values()].filter((deployment) => deployment.projectId === projectId),
    );
  }

  private withLatest(project: ProjectRecord): ProjectWithLatest {
    const deployments = this.deploymentsOf(project.id);
    const latest = deployments[0];
    const live = deployments.find((deployment) => deployment.status === "live");
    return {
      project: { ...project },
      latest: latest ? { ...latest } : null,
      live: live ? { ...live } : null,
    };
  }
}

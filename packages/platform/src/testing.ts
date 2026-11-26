import { randomUUID } from "node:crypto";
import {
  canTransition,
  isActiveDeployment,
  type DeploymentStatus,
} from "@cloud-platform/contracts";
import {
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
  available = true;

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
    const deployment: DeploymentRecord = {
      id: randomUUID(),
      projectId: project.id,
      status: "pending",
      imageRef: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.projects.set(project.id, project);
    this.deployments.set(deployment.id, deployment);
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

  async findWork(): Promise<ControllerWork> {
    const deployments = [...this.deployments.values()]
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
      for (const other of this.deployments.values()) {
        if (other.projectId === deployment.projectId && other.status === "live") {
          other.status = "superseded";
          other.updatedAt = now;
        }
      }
    }
    if (from === "pending") deployment.startedAt ??= now;
    if (to === "live" || to === "failed" || to === "cancelled") deployment.finishedAt ??= now;
    deployment.status = to;
    deployment.updatedAt = now;
    if (fields.imageRef !== undefined) deployment.imageRef = fields.imageRef;
    if (fields.failureReason !== undefined) deployment.failureReason = fields.failureReason;
    return { ...deployment };
  }

  async remove(id: string): Promise<void> {
    this.projects.delete(id);
    for (const [deploymentId, deployment] of this.deployments) {
      if (deployment.projectId === id) this.deployments.delete(deploymentId);
    }
  }

  /** Overridable clock, so tests can simulate time passing. */
  now(): Date {
    return new Date();
  }

  private withLatest(project: ProjectRecord): ProjectWithLatest {
    const latest = [...this.deployments.values()]
      .filter((deployment) => deployment.projectId === project.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return { project: { ...project }, latest: latest ? { ...latest } : null };
  }
}

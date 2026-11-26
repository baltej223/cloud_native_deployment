import {
  createProjectRequestSchema,
  normalizeImageReference,
  type BuildLogResponse,
  type CreateProjectInput,
  type CreateProjectResponse,
  type DeploymentView,
  type ProjectSource,
  type ProjectView,
} from "@cloud-platform/contracts";
import type { Router } from "@cloud-platform/drivers";
import {
  BUILD_LOG_MAX_CHARS,
  DeploymentInProgressError,
  NameTakenError,
  NoFreePortError,
  ProjectLimitError,
  type DeploymentRecord,
  type Logger,
  type ProjectLimits,
  type ProjectRepository,
  type ProjectWithLatest,
} from "@cloud-platform/platform";
import type { ZodIssue } from "zod";
import { HttpError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describeIssue(issue: ZodIssue): string {
  const field = issue.path.join(".");
  if (issue.code === "invalid_type" && field) {
    return issue.received === "undefined"
      ? `${field} is required.`
      : `${field} must be ${issue.expected === "object" ? "an object" : `a ${issue.expected}`}.`;
  }
  return issue.message;
}

/** Validate a POST /projects body, throwing an HttpError with a client-safe message. */
export function parseCreateProject(body: unknown): CreateProjectInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_INPUT", "Request body must be a JSON object.");
  }
  const parsed = createProjectRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new HttpError(400, "INVALID_INPUT", issue ? describeIssue(issue) : "Invalid request.");
}

export function toDeploymentView(deployment: DeploymentRecord): DeploymentView {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    status: deployment.status,
    imageRef: deployment.imageRef,
    commitSha: deployment.commitSha,
    dockerfilePath: deployment.dockerfilePath,
    containerPort: deployment.containerPort,
    failureReason: deployment.failureReason,
    createdAt: deployment.createdAt.toISOString(),
    startedAt: deployment.startedAt?.toISOString() ?? null,
    finishedAt: deployment.finishedAt?.toISOString() ?? null,
  };
}

const projectNotFound = () =>
  new HttpError(404, "PROJECT_NOT_FOUND", "No project exists with that ID.");
const deploymentNotFound = () =>
  new HttpError(404, "DEPLOYMENT_NOT_FOUND", "No deployment exists with that ID.");

/** Use cases behind the /projects and /deployments routes. */
export class ProjectsService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly router: Router,
    private readonly limits: ProjectLimits,
    private readonly logger: Logger,
  ) {}

  toView({ project, latest, live }: ProjectWithLatest): ProjectView {
    return {
      id: project.id,
      name: project.name,
      source: project.source,
      containerPort: project.containerPort,
      healthCheckPath: project.healthCheckPath,
      env: project.env,
      url: this.router.urlFor({ name: project.name, publicPort: project.assignedPort }),
      status: project.deletedAt ? "deleting" : (latest?.status ?? "pending"),
      latestDeployment: latest ? toDeploymentView(latest) : null,
      liveDeployment: live ? toDeploymentView(live) : null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  async create(body: unknown): Promise<CreateProjectResponse> {
    const input = parseCreateProject(body);
    const nameWasDerived = (body as { name?: unknown }).name === undefined;
    const source: ProjectSource =
      input.source.type === "image"
        ? { type: "image", image: normalizeImageReference(input.source.image) }
        : input.source;
    try {
      const { project, deployment } = await this.repository.create(
        { ...input, source },
        this.limits,
      );
      this.logger.info(
        { projectId: project.id, deploymentId: deployment.id, name: project.name, source },
        "project created",
      );
      return {
        project: this.toView({ project, latest: deployment, live: null }),
        deployment: toDeploymentView(deployment),
      };
    } catch (error) {
      if (error instanceof NameTakenError) {
        throw new HttpError(
          409,
          "NAME_TAKEN",
          nameWasDerived ? `${error.message} Choose a different project name.` : error.message,
        );
      }
      if (error instanceof ProjectLimitError) {
        throw new HttpError(409, "PROJECT_LIMIT_REACHED", error.message);
      }
      if (error instanceof NoFreePortError) throw new HttpError(409, "NO_FREE_PORT", error.message);
      throw error;
    }
  }

  async list(): Promise<ProjectView[]> {
    return (await this.repository.list()).map((entry) => this.toView(entry));
  }

  async get(id: string): Promise<ProjectView> {
    const entry = UUID.test(id) ? await this.repository.get(id) : null;
    if (!entry) throw projectNotFound();
    return this.toView(entry);
  }

  /** Mark the project for deletion; the controller removes the app and then the record. */
  async delete(id: string): Promise<void> {
    if (!UUID.test(id) || !(await this.repository.markDeleted(id))) throw projectNotFound();
    this.logger.info({ projectId: id }, "project marked for deletion");
  }

  /** Deploy the project again: rebuild from the latest commit, or pull the image again. */
  async redeploy(projectId: string): Promise<DeploymentView> {
    if (!UUID.test(projectId)) throw projectNotFound();
    try {
      const deployment = await this.repository.createDeployment(projectId);
      if (!deployment) throw projectNotFound();
      this.logger.info({ projectId, deploymentId: deployment.id }, "redeploy requested");
      return toDeploymentView(deployment);
    } catch (error) {
      if (error instanceof DeploymentInProgressError) {
        throw new HttpError(409, "DEPLOYMENT_IN_PROGRESS", error.message);
      }
      throw error;
    }
  }

  async listDeployments(projectId: string): Promise<DeploymentView[]> {
    if (!UUID.test(projectId) || !(await this.repository.get(projectId))) throw projectNotFound();
    return (await this.repository.listDeployments(projectId)).map(toDeploymentView);
  }

  async getDeployment(id: string): Promise<DeploymentView> {
    const deployment = UUID.test(id) ? await this.repository.getDeployment(id) : null;
    if (!deployment) throw deploymentNotFound();
    return toDeploymentView(deployment);
  }

  async getBuildLog(id: string): Promise<BuildLogResponse> {
    const deployment = UUID.test(id) ? await this.repository.getDeployment(id) : null;
    const log = deployment ? await this.repository.getBuildLog(id) : null;
    if (!deployment || log === null) throw deploymentNotFound();
    return {
      deploymentId: id,
      status: deployment.status,
      log,
      truncated: log.length >= BUILD_LOG_MAX_CHARS,
    };
  }
}

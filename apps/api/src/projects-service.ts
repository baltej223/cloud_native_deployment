import {
  createProjectRequestSchema,
  isActiveDeployment,
  normalizeImageReference,
  rollbackRequestSchema,
  updateProjectRequestSchema,
  type BuildLogResponse,
  type CreateProjectInput,
  type CreateProjectResponse,
  type DeploymentView,
  type ProjectSource,
  type ProjectView,
  type RuntimeLogResponse,
} from "@cloud-platform/contracts";
import type { Router, Runtime } from "@cloud-platform/drivers";
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
  return parseBody(createProjectRequestSchema, body);
}

/** Validate a JSON object body with a zod schema, throwing a client-safe HttpError. */
function parseBody<T>(
  schema: {
    safeParse(
      body: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } };
  },
  body: unknown,
): T {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_INPUT", "Request body must be a JSON object.");
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const message =
    issue?.code === "unrecognized_keys"
      ? `${issue.keys.join(", ")} cannot be changed.`
      : issue
        ? describeIssue(issue)
        : "Invalid request.";
  throw new HttpError(400, "INVALID_INPUT", message);
}

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2_000;

export function toDeploymentView(deployment: DeploymentRecord): DeploymentView {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    status: deployment.status,
    imageRef: deployment.imageRef,
    commitSha: deployment.commitSha,
    dockerfilePath: deployment.dockerfilePath,
    compose: deployment.compose
      ? {
          file: deployment.compose.file,
          publicService: deployment.compose.publicService,
          services: deployment.compose.services.map((service) => service.name),
        }
      : null,
    containerPort: deployment.containerPort,
    rollbackOf: deployment.rollbackOf,
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
    private readonly runtime: Runtime,
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
      status: project.deletedAt
        ? "deleting"
        : project.desiredState === "stopped" && !(latest && isActiveDeployment(latest.status))
          ? "stopped"
          : (latest?.status ?? "pending"),
      desiredState: project.desiredState,
      stopReason: project.stopReason,
      lastActiveAt: project.lastActiveAt.toISOString(),
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
    const deployment = await this.startDeployment(projectId);
    this.logger.info({ projectId, deploymentId: deployment.id }, "redeploy requested");
    return toDeploymentView(deployment);
  }

  /** Deploy an earlier version again from its image, without building. */
  async rollback(projectId: string, body: unknown): Promise<DeploymentView> {
    const { deploymentId } = parseBody(rollbackRequestSchema, body);
    const entry = await this.findProject(projectId);
    const target = await this.repository.getDeployment(deploymentId);
    if (!target || target.projectId !== projectId) throw deploymentNotFound();
    if (target.id === entry.live?.id) {
      throw new HttpError(409, "ROLLBACK_NOT_POSSIBLE", "That deployment is already live.");
    }
    if (!(target.status === "live" || target.status === "superseded") || !target.imageRef) {
      throw new HttpError(
        409,
        "ROLLBACK_NOT_POSSIBLE",
        "Only deployments that were live before can be rolled back to.",
      );
    }
    const deployment = await this.startDeployment(projectId, target);
    this.logger.info(
      { projectId, deploymentId: deployment.id, rollbackOf: target.id },
      "rollback requested",
    );
    return toDeploymentView(deployment);
  }

  private async startDeployment(projectId: string, rollbackOf?: DeploymentRecord) {
    try {
      const deployment = await this.repository.createDeployment(projectId, rollbackOf);
      if (!deployment) throw projectNotFound();
      return deployment;
    } catch (error) {
      if (error instanceof DeploymentInProgressError) {
        throw new HttpError(409, "DEPLOYMENT_IN_PROGRESS", error.message);
      }
      throw error;
    }
  }

  /** Change settings; they apply to the next deployment. */
  async update(id: string, body: unknown): Promise<ProjectView> {
    const changes = parseBody(updateProjectRequestSchema, body);
    const { project } = await this.findProject(id);
    if (project.source.type === "image") {
      const repoOnly = (["branch", "dockerfilePath", "composeService"] as const).filter(
        (key) => changes[key] !== undefined,
      );
      if (repoOnly.length) {
        throw new HttpError(
          400,
          "INVALID_INPUT",
          `${repoOnly.join(", ")} only apply to repository projects.`,
        );
      }
      if (changes.containerPort === null) {
        throw new HttpError(400, "INVALID_INPUT", "containerPort is required for image projects.");
      }
    }
    if (!(await this.repository.update(id, changes))) throw projectNotFound();
    this.logger.info({ projectId: id, changed: Object.keys(changes) }, "project settings changed");
    return this.get(id);
  }

  /** Stop the app; its containers and data are kept for a later start. */
  async stop(id: string): Promise<ProjectView> {
    const entry = await this.findProject(id);
    if (entry.latest && isActiveDeployment(entry.latest.status)) {
      throw new HttpError(
        409,
        "DEPLOYMENT_IN_PROGRESS",
        "A deployment is in progress. Wait for it to finish, then stop the app.",
      );
    }
    if (!entry.live) {
      throw new HttpError(409, "NO_LIVE_DEPLOYMENT", "The app has no live version to stop.");
    }
    await this.repository.setDesiredState(id, "stopped", "user");
    this.logger.info({ projectId: id }, "stop requested");
    return this.get(id);
  }

  /** Start a stopped app again (the live version, without building). */
  async start(id: string): Promise<ProjectView> {
    const entry = await this.findProject(id);
    if (!entry.live) {
      throw new HttpError(
        409,
        "NO_LIVE_DEPLOYMENT",
        "The app has no live version to start. Deploy it first.",
      );
    }
    await this.repository.setDesiredState(id, "running", null);
    this.logger.info({ projectId: id }, "start requested");
    return this.get(id);
  }

  /** The last lines the running app (or one of its compose services) wrote. */
  async runtimeLogs(
    id: string,
    service: string | undefined,
    tail: string | undefined,
  ): Promise<RuntimeLogResponse> {
    const { live } = await this.findProject(id);
    const services = live?.compose?.services.map((entry) => entry.name) ?? [];
    if (service && !services.includes(service)) {
      throw new HttpError(
        400,
        "INVALID_INPUT",
        services.length
          ? `service must be one of: ${services.join(", ")}.`
          : "service only applies to compose apps.",
      );
    }
    const lines = tail === undefined ? DEFAULT_LOG_LINES : Number(tail);
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
      throw new HttpError(400, "INVALID_INPUT", `tail must be between 1 and ${MAX_LOG_LINES}.`);
    }
    const chosen = service ?? live?.compose?.publicService ?? null;
    const log = live ? await this.runtime.logs(id, service ?? null, lines) : null;
    return { projectId: id, service: chosen, services, log: log ?? "" };
  }

  private async findProject(id: string): Promise<ProjectWithLatest> {
    const entry = UUID.test(id) ? await this.repository.get(id) : null;
    if (!entry || entry.project.deletedAt) throw projectNotFound();
    return entry;
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

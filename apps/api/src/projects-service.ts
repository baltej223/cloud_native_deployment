import {
  createProjectRequestSchema,
  normalizeImageReference,
  type CreateProjectInput,
  type CreateProjectResponse,
  type DeploymentView,
  type ProjectView,
} from "@cloud-platform/contracts";
import type { Router } from "@cloud-platform/drivers";
import {
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
    failureReason: deployment.failureReason,
    createdAt: deployment.createdAt.toISOString(),
    startedAt: deployment.startedAt?.toISOString() ?? null,
    finishedAt: deployment.finishedAt?.toISOString() ?? null,
  };
}

/** Use cases behind the /projects routes. */
export class ProjectsService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly router: Router,
    private readonly limits: ProjectLimits,
    private readonly logger: Logger,
  ) {}

  toView({ project, latest }: ProjectWithLatest): ProjectView {
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
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  async create(body: unknown): Promise<CreateProjectResponse> {
    const input = parseCreateProject(body);
    const source = { type: "image" as const, image: normalizeImageReference(input.source.image) };
    try {
      const { project, deployment } = await this.repository.create(
        { ...input, source },
        this.limits,
      );
      this.logger.info(
        {
          projectId: project.id,
          deploymentId: deployment.id,
          name: project.name,
          image: source.image,
        },
        "project created",
      );
      return {
        project: this.toView({ project, latest: deployment }),
        deployment: toDeploymentView(deployment),
      };
    } catch (error) {
      if (error instanceof NameTakenError) throw new HttpError(409, "NAME_TAKEN", error.message);
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
    if (!entry) throw new HttpError(404, "PROJECT_NOT_FOUND", "No project exists with that ID.");
    return this.toView(entry);
  }

  /** Mark the project for deletion; the controller removes the app and then the record. */
  async delete(id: string): Promise<void> {
    if (!UUID.test(id) || !(await this.repository.markDeleted(id))) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "No project exists with that ID.");
    }
    this.logger.info({ projectId: id }, "project marked for deletion");
  }
}

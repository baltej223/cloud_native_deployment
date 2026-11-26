import { randomUUID } from "node:crypto";
import {
  canTransition,
  type ComposePlan,
  type DeploymentStatus,
  type ProjectSource,
} from "@cloud-platform/contracts";
import type pg from "pg";
import type { DatabasePool } from "./database.js";

export interface ProjectRecord {
  id: string;
  name: string;
  source: ProjectSource;
  /** Given by the user; null means "detect from the Dockerfile". */
  containerPort: number | null;
  healthCheckPath: string;
  env: Record<string, string>;
  assignedPort: number;
  desiredState: "running" | "stopped";
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeploymentRecord {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  imageRef: string | null;
  commitSha: string | null;
  dockerfilePath: string | null;
  contextPath: string | null;
  containerPort: number | null;
  /** Compose apps: the services this deployment runs. */
  compose: ComposePlan | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  /** When the deployment entered "deploying" (after any build). */
  deployStartedAt: Date | null;
  finishedAt: Date | null;
}

export interface ProjectWithLatest {
  project: ProjectRecord;
  latest: DeploymentRecord | null;
  /** The deployment currently serving the project's URL, if any. */
  live: DeploymentRecord | null;
}

export interface NewProject {
  name: string;
  source: ProjectSource;
  containerPort: number | null;
  healthCheckPath: string;
  env: Record<string, string>;
}

export interface ProjectLimits {
  /** Inclusive range of ports handed out to projects. */
  portRange: { min: number; max: number };
  maxProjects: number;
}

export class NameTakenError extends Error {
  constructor(readonly projectName: string) {
    super(`A project named "${projectName}" already exists.`);
    this.name = "NameTakenError";
  }
}

export class ProjectLimitError extends Error {
  constructor(max: number) {
    super(`The platform allows at most ${max} projects. Delete one first.`);
    this.name = "ProjectLimitError";
  }
}

export class NoFreePortError extends Error {
  constructor() {
    super("Every app port is in use. Delete a project first.");
    this.name = "NoFreePortError";
  }
}

export class DeploymentInProgressError extends Error {
  constructor() {
    super("A deployment of this project is already in progress.");
    this.name = "DeploymentInProgressError";
  }
}

export interface TransitionFields {
  imageRef?: string;
  failureReason?: string;
  commitSha?: string;
  dockerfilePath?: string;
  contextPath?: string;
  containerPort?: number;
  compose?: ComposePlan;
}

/** Work the deployment controller has to do. */
export interface ControllerWork {
  /** Deployments in progress (pending, building, deploying) of projects not being deleted. */
  deployments: Array<{ project: ProjectRecord; deployment: DeploymentRecord }>;
  /** Projects marked for deletion whose app still has to be removed. */
  deletions: ProjectRecord[];
}

export interface ProjectRepository {
  ping(): Promise<void>;
  /** Create a project and its first deployment, assigning a free port. */
  create(
    input: NewProject,
    limits: ProjectLimits,
  ): Promise<{ project: ProjectRecord; deployment: DeploymentRecord }>;
  /** All projects, including those being deleted, newest first. */
  list(): Promise<ProjectWithLatest[]>;
  get(id: string): Promise<ProjectWithLatest | null>;
  /** Mark a project for deletion. Returns false if it does not exist. */
  markDeleted(id: string): Promise<boolean>;
  /**
   * Start a new deployment of an existing project (a redeploy). Returns null
   * if the project does not exist or is being deleted; throws
   * DeploymentInProgressError if one is already running.
   */
  createDeployment(projectId: string): Promise<DeploymentRecord | null>;
  /** A project's deployments, newest first. */
  listDeployments(projectId: string, limit?: number): Promise<DeploymentRecord[]>;
  getDeployment(id: string): Promise<DeploymentRecord | null>;
  getBuildLog(id: string): Promise<string | null>;
  /** Replace the stored build log (the controller writes it as the build runs). */
  setBuildLog(id: string, log: string): Promise<void>;
  findWork(): Promise<ControllerWork>;
  /**
   * Move a deployment from `from` to `to`, only if it is still in `from`.
   * Going live supersedes the project's previous live deployment.
   * Returns the updated deployment, or null if it was no longer in `from`.
   */
  transition(
    id: string,
    from: DeploymentStatus,
    to: DeploymentStatus,
    fields?: TransitionFields,
  ): Promise<DeploymentRecord | null>;
  /** Delete the project row and its deployments (after its app is removed). */
  remove(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  source_type: "image" | "repo";
  image: string | null;
  repo_url: string | null;
  branch: string | null;
  dockerfile_path: string | null;
  compose_service: string | null;
  container_port: number | null;
  health_check_path: string;
  env: Record<string, string>;
  assigned_port: number;
  desired_state: "running" | "stopped";
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Deployment columns as returned directly, or as JSON (timestamps as strings). */
interface DeploymentRow {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  image_ref: string | null;
  commit_sha: string | null;
  dockerfile_path: string | null;
  context_path: string | null;
  container_port: number | null;
  compose: ComposePlan | null;
  failure_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  deploy_started_at: Date | string | null;
  finished_at: Date | string | null;
}

const date = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const optionalDate = (value: Date | string | null) => (value === null ? null : date(value));

function toProject(row: ProjectRow): ProjectRecord {
  const source: ProjectSource =
    row.source_type === "repo"
      ? {
          type: "repo",
          repoUrl: row.repo_url!,
          ...(row.branch ? { branch: row.branch } : {}),
          ...(row.dockerfile_path ? { dockerfilePath: row.dockerfile_path } : {}),
          ...(row.compose_service ? { composeService: row.compose_service } : {}),
        }
      : { type: "image", image: row.image! };
  return {
    id: row.id,
    name: row.name,
    source,
    containerPort: row.container_port,
    healthCheckPath: row.health_check_path,
    env: row.env,
    assignedPort: row.assigned_port,
    desiredState: row.desired_state,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDeployment(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    imageRef: row.image_ref,
    commitSha: row.commit_sha,
    dockerfilePath: row.dockerfile_path,
    contextPath: row.context_path,
    containerPort: row.container_port,
    compose: row.compose ?? null,
    failureReason: row.failure_reason,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    startedAt: optionalDate(row.started_at),
    deployStartedAt: optionalDate(row.deploy_started_at),
    finishedAt: optionalDate(row.finished_at),
  };
}

const PROJECT_COLUMNS = `p.id, p.name, p.source_type, p.image, p.repo_url, p.branch, p.dockerfile_path,
  p.compose_service, p.container_port, p.health_check_path, p.env, p.assigned_port, p.desired_state, p.deleted_at,
  p.created_at, p.updated_at`;

/** Everything except the (large) build log. */
const DEPLOYMENT_COLUMNS = `d.id, d.project_id, d.status, d.image_ref, d.commit_sha, d.dockerfile_path,
  d.context_path, d.container_port, d.compose, d.failure_reason, d.created_at, d.updated_at, d.started_at,
  d.deploy_started_at, d.finished_at`;

/** A project with its latest and live deployments as JSON columns. */
const PROJECT_WITH_DEPLOYMENTS = `SELECT ${PROJECT_COLUMNS},
    (SELECT row_to_json(x) FROM (
       SELECT ${DEPLOYMENT_COLUMNS} FROM deployments d
        WHERE d.project_id = p.id ORDER BY d.created_at DESC LIMIT 1) x) AS latest,
    (SELECT row_to_json(x) FROM (
       SELECT ${DEPLOYMENT_COLUMNS} FROM deployments d
        WHERE d.project_id = p.id AND d.status = 'live' LIMIT 1) x) AS live
  FROM projects p`;

type ProjectWithDeploymentsRow = ProjectRow & {
  latest: DeploymentRow | null;
  live: DeploymentRow | null;
};

function toProjectWithLatest(row: ProjectWithDeploymentsRow): ProjectWithLatest {
  return {
    project: toProject(row),
    latest: row.latest ? toDeployment(row.latest) : null,
    live: row.live ? toDeployment(row.live) : null,
  };
}

/** Serialises project creation so the project limit and port choice cannot race. */
const CREATE_LOCK_ID = 7_241_999;

/** Build logs keep their last 256 KB. */
export const BUILD_LOG_MAX_CHARS = 256 * 1024;

const isUniqueViolation = (error: unknown, constraint: string) =>
  (error as { code?: string; constraint?: string }).code === "23505" &&
  (error as { constraint?: string }).constraint === constraint;

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly pool: DatabasePool) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async create(input: NewProject, limits: ProjectLimits) {
    return this.inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CREATE_LOCK_ID]);

      const { rows: countRows } = await client.query<{ count: string }>(
        "SELECT count(*) FROM projects",
      );
      if (Number(countRows[0]!.count) >= limits.maxProjects) {
        throw new ProjectLimitError(limits.maxProjects);
      }

      const { rows: portRows } = await client.query<{ port: number }>(
        `SELECT port FROM generate_series($1::int, $2::int) AS port
          WHERE port NOT IN (SELECT assigned_port FROM projects)
          ORDER BY port LIMIT 1`,
        [limits.portRange.min, limits.portRange.max],
      );
      const port = portRows[0]?.port;
      if (port === undefined) throw new NoFreePortError();

      const { source } = input;
      let projectRow: ProjectRow;
      try {
        const { rows } = await client.query<ProjectRow>(
          `INSERT INTO projects AS p (id, name, source_type, image, repo_url, branch,
             dockerfile_path, container_port, health_check_path, env, assigned_port,
             compose_service)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING ${PROJECT_COLUMNS}`,
          [
            randomUUID(),
            input.name,
            source.type,
            source.type === "image" ? source.image : null,
            source.type === "repo" ? source.repoUrl : null,
            source.type === "repo" ? (source.branch ?? null) : null,
            source.type === "repo" ? (source.dockerfilePath ?? null) : null,
            input.containerPort,
            input.healthCheckPath,
            JSON.stringify(input.env),
            port,
            source.type === "repo" ? (source.composeService ?? null) : null,
          ],
        );
        projectRow = rows[0]!;
      } catch (error) {
        if (isUniqueViolation(error, "projects_name_key")) throw new NameTakenError(input.name);
        throw error;
      }

      const { rows: deploymentRows } = await client.query<DeploymentRow>(
        `INSERT INTO deployments AS d (id, project_id) VALUES ($1, $2)
         RETURNING ${DEPLOYMENT_COLUMNS}`,
        [randomUUID(), projectRow.id],
      );
      return { project: toProject(projectRow), deployment: toDeployment(deploymentRows[0]!) };
    });
  }

  async list(): Promise<ProjectWithLatest[]> {
    const { rows } = await this.pool.query<ProjectWithDeploymentsRow>(
      `${PROJECT_WITH_DEPLOYMENTS} ORDER BY p.created_at DESC`,
    );
    return rows.map(toProjectWithLatest);
  }

  async get(id: string): Promise<ProjectWithLatest | null> {
    const { rows } = await this.pool.query<ProjectWithDeploymentsRow>(
      `${PROJECT_WITH_DEPLOYMENTS} WHERE p.id = $1`,
      [id],
    );
    return rows[0] ? toProjectWithLatest(rows[0]) : null;
  }

  async markDeleted(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE projects SET deleted_at = coalesce(deleted_at, now()), updated_at = now()
        WHERE id = $1`,
      [id],
    );
    return rowCount === 1;
  }

  async createDeployment(projectId: string): Promise<DeploymentRecord | null> {
    try {
      const { rows } = await this.pool.query<DeploymentRow>(
        `INSERT INTO deployments AS d (id, project_id)
         SELECT $1, id FROM projects WHERE id = $2 AND deleted_at IS NULL
         RETURNING ${DEPLOYMENT_COLUMNS}`,
        [randomUUID(), projectId],
      );
      return rows[0] ? toDeployment(rows[0]) : null;
    } catch (error) {
      if (isUniqueViolation(error, "deployments_one_active_per_project")) {
        throw new DeploymentInProgressError();
      }
      throw error;
    }
  }

  async listDeployments(projectId: string, limit = 20): Promise<DeploymentRecord[]> {
    const { rows } = await this.pool.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments d
        WHERE d.project_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return rows.map(toDeployment);
  }

  async getDeployment(id: string): Promise<DeploymentRecord | null> {
    const { rows } = await this.pool.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments d WHERE d.id = $1`,
      [id],
    );
    return rows[0] ? toDeployment(rows[0]) : null;
  }

  async getBuildLog(id: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ build_log: string }>(
      "SELECT build_log FROM deployments WHERE id = $1",
      [id],
    );
    return rows[0]?.build_log ?? null;
  }

  async setBuildLog(id: string, log: string): Promise<void> {
    await this.pool.query("UPDATE deployments SET build_log = $2 WHERE id = $1", [
      id,
      log.length > BUILD_LOG_MAX_CHARS ? log.slice(-BUILD_LOG_MAX_CHARS) : log,
    ]);
  }

  async findWork(): Promise<ControllerWork> {
    const [active, deleting] = await Promise.all([
      this.pool.query<ProjectRow & { deployment: DeploymentRow }>(
        `SELECT ${PROJECT_COLUMNS}, row_to_json(x) AS deployment
           FROM projects p
           JOIN LATERAL (
             SELECT ${DEPLOYMENT_COLUMNS} FROM deployments d
              WHERE d.project_id = p.id AND d.status IN ('pending', 'building', 'deploying')
           ) x ON true
          WHERE p.deleted_at IS NULL
          ORDER BY x.created_at`,
      ),
      this.pool.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.deleted_at IS NOT NULL`,
      ),
    ]);
    return {
      deployments: active.rows.map((row) => ({
        project: toProject(row),
        deployment: toDeployment(row.deployment),
      })),
      deletions: deleting.rows.map(toProject),
    };
  }

  async transition(
    id: string,
    from: DeploymentStatus,
    to: DeploymentStatus,
    fields: TransitionFields = {},
  ): Promise<DeploymentRecord | null> {
    if (!canTransition(from, to)) {
      throw new Error(`invalid deployment transition ${from} -> ${to}`);
    }
    const notInState = Symbol("not in state");
    try {
      return await this.inTransaction(async (client) => {
        if (to === "live") {
          await client.query(
            `UPDATE deployments SET status = 'superseded'
              WHERE status = 'live' AND id <> $1
                AND project_id = (SELECT project_id FROM deployments WHERE id = $1)`,
            [id],
          );
        }
        const { rows } = await client.query<DeploymentRow>(
          `UPDATE deployments AS d
              SET status = $3,
                  image_ref = coalesce($4, image_ref),
                  failure_reason = coalesce($5, failure_reason),
                  commit_sha = coalesce($6, commit_sha),
                  dockerfile_path = coalesce($7, dockerfile_path),
                  context_path = coalesce($8, context_path),
                  container_port = coalesce($9, container_port),
                  compose = coalesce($10, compose)
            WHERE id = $1 AND status = $2
            RETURNING ${DEPLOYMENT_COLUMNS}`,
          [
            id,
            from,
            to,
            fields.imageRef ?? null,
            fields.failureReason ?? null,
            fields.commitSha ?? null,
            fields.dockerfilePath ?? null,
            fields.contextPath ?? null,
            fields.containerPort ?? null,
            fields.compose ? JSON.stringify(fields.compose) : null,
          ],
        );
        // Roll back the supersede above if this deployment had already moved on.
        if (!rows[0]) throw notInState;
        return toDeployment(rows[0]);
      });
    } catch (error) {
      if (error === notInState) return null;
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await this.pool.query("DELETE FROM projects WHERE id = $1", [id]);
  }

  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

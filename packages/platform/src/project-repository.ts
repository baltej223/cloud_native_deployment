import { randomUUID } from "node:crypto";
import {
  canTransition,
  type ComposePlan,
  type DeploymentStatus,
  type DesiredState,
  type ProjectSource,
  type StopReason,
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
  desiredState: DesiredState;
  stopReason: StopReason | null;
  /** Last network activity of the app, or when it was last started. */
  lastActiveAt: Date;
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
  /** The earlier deployment whose image this one reuses (a rollback). */
  rollbackOf: string | null;
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

/** Changes to a project's settings; null resets a repository setting to automatic. */
export interface ProjectUpdate {
  containerPort?: number | null;
  healthCheckPath?: string;
  env?: Record<string, string>;
  branch?: string | null;
  dockerfilePath?: string | null;
  composeService?: string | null;
}

/** Work the deployment controller has to do. */
export interface ControllerWork {
  /** Deployments in progress (pending, building, deploying) of projects not being deleted. */
  deployments: Array<{ project: ProjectRecord; deployment: DeploymentRecord }>;
  /**
   * Projects with a live deployment and nothing in progress: their containers
   * must match the desired state (running or stopped).
   */
  settled: Array<{ project: ProjectRecord; live: DeploymentRecord }>;
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
  /** Change settings of a project that is not being deleted. Returns null if there is none. */
  update(id: string, changes: ProjectUpdate): Promise<ProjectRecord | null>;
  /**
   * Start or stop a project. Starting clears the stop reason and counts as
   * activity. Returns null if the project does not exist or is being deleted.
   */
  setDesiredState(
    id: string,
    state: DesiredState,
    reason: StopReason | null,
  ): Promise<ProjectRecord | null>;
  /** Record that the app had network traffic at `at`. */
  markActive(id: string, at: Date): Promise<void>;
  /**
   * Start a new deployment of an existing project: a redeploy, or a rollback
   * that reuses `rollbackOf`'s image. The project is set to running. Returns
   * null if the project does not exist or is being deleted; throws
   * DeploymentInProgressError if one is already running.
   */
  createDeployment(
    projectId: string,
    rollbackOf?: DeploymentRecord,
  ): Promise<DeploymentRecord | null>;
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
  /**
   * Try to become the one controller allowed to act (a PostgreSQL advisory
   * lock held for as long as this process keeps its connection). True while
   * this instance holds it; safe to call every tick.
   */
  tryLockController(): Promise<boolean>;
  unlockController(): Promise<void>;
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
  desired_state: DesiredState;
  stop_reason: StopReason | null;
  last_active_at: Date;
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
  rollback_of: string | null;
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
    stopReason: row.stop_reason,
    lastActiveAt: row.last_active_at,
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
    rollbackOf: row.rollback_of,
    failureReason: row.failure_reason,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    startedAt: optionalDate(row.started_at),
    deployStartedAt: optionalDate(row.deploy_started_at),
    finishedAt: optionalDate(row.finished_at),
  };
}

const PROJECT_COLUMNS = `p.id, p.name, p.source_type, p.image, p.repo_url, p.branch, p.dockerfile_path,
  p.compose_service, p.container_port, p.health_check_path, p.env, p.assigned_port, p.desired_state, p.stop_reason,
  p.last_active_at, p.deleted_at,
  p.created_at, p.updated_at`;

/** Everything except the (large) build log. */
const DEPLOYMENT_COLUMNS = `d.id, d.project_id, d.status, d.image_ref, d.commit_sha, d.dockerfile_path,
  d.context_path, d.container_port, d.compose, d.rollback_of, d.failure_reason, d.created_at, d.updated_at, d.started_at,
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
/** Held by the one API instance that runs the deployment controller. */
const CONTROLLER_LOCK_ID = 7_242_000;

/** Build logs keep their last 256 KB. */
export const BUILD_LOG_MAX_CHARS = 256 * 1024;

const isUniqueViolation = (error: unknown, constraint: string) =>
  (error as { code?: string; constraint?: string }).code === "23505" &&
  (error as { constraint?: string }).constraint === constraint;

export class PostgresProjectRepository implements ProjectRepository {
  /** Connection that holds the controller lock (advisory locks belong to a session). */
  private lockClient: pg.PoolClient | null = null;

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

  async update(id: string, changes: ProjectUpdate): Promise<ProjectRecord | null> {
    const columns: Array<[string, unknown]> = [];
    if (changes.containerPort !== undefined)
      columns.push(["container_port", changes.containerPort]);
    if (changes.healthCheckPath !== undefined) {
      columns.push(["health_check_path", changes.healthCheckPath]);
    }
    if (changes.env !== undefined) columns.push(["env", JSON.stringify(changes.env)]);
    if (changes.branch !== undefined) columns.push(["branch", changes.branch]);
    if (changes.dockerfilePath !== undefined) {
      columns.push(["dockerfile_path", changes.dockerfilePath]);
    }
    if (changes.composeService !== undefined) {
      columns.push(["compose_service", changes.composeService]);
    }
    const assignments = columns.map(([column], index) => `${column} = $${index + 2}`);
    const { rows } = await this.pool.query<ProjectRow>(
      `UPDATE projects AS p SET ${[...assignments, "updated_at = now()"].join(", ")}
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${PROJECT_COLUMNS}`,
      [id, ...columns.map(([, value]) => value)],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async setDesiredState(
    id: string,
    state: DesiredState,
    reason: StopReason | null,
  ): Promise<ProjectRecord | null> {
    const { rows } = await this.pool.query<ProjectRow>(
      `UPDATE projects AS p
          SET desired_state = $2,
              stop_reason = $3,
              last_active_at = CASE WHEN $2 = 'running' THEN now() ELSE last_active_at END,
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${PROJECT_COLUMNS}`,
      [id, state, state === "running" ? null : reason],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async markActive(id: string, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE projects SET last_active_at = greatest(last_active_at, $2) WHERE id = $1",
      [id, at],
    );
  }

  async createDeployment(
    projectId: string,
    rollbackOf?: DeploymentRecord,
  ): Promise<DeploymentRecord | null> {
    try {
      return await this.inTransaction(async (client) => {
        const { rows } = await client.query<DeploymentRow>(
          `INSERT INTO deployments AS d (id, project_id, rollback_of, image_ref, commit_sha,
             dockerfile_path, context_path, container_port, compose)
           SELECT $1, id, $3, $4, $5, $6, $7, $8, $9
             FROM projects WHERE id = $2 AND deleted_at IS NULL
           RETURNING ${DEPLOYMENT_COLUMNS}`,
          [
            randomUUID(),
            projectId,
            rollbackOf?.id ?? null,
            rollbackOf?.imageRef ?? null,
            rollbackOf?.commitSha ?? null,
            rollbackOf?.dockerfilePath ?? null,
            rollbackOf?.contextPath ?? null,
            rollbackOf?.containerPort ?? null,
            rollbackOf?.compose ? JSON.stringify(rollbackOf.compose) : null,
          ],
        );
        if (!rows[0]) return null;
        // Deploying a project means it should run.
        await client.query(
          `UPDATE projects SET desired_state = 'running', stop_reason = NULL,
              last_active_at = now(), updated_at = now()
            WHERE id = $1`,
          [projectId],
        );
        return toDeployment(rows[0]);
      });
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
    const [active, deleting, settled] = await Promise.all([
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
      this.pool.query<ProjectRow & { live: DeploymentRow }>(
        `SELECT ${PROJECT_COLUMNS}, row_to_json(x) AS live
           FROM projects p
           JOIN LATERAL (
             SELECT ${DEPLOYMENT_COLUMNS} FROM deployments d
              WHERE d.project_id = p.id AND d.status = 'live'
           ) x ON true
          WHERE p.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM deployments a
               WHERE a.project_id = p.id AND a.status IN ('pending', 'building', 'deploying'))
          ORDER BY p.created_at`,
      ),
    ]);
    return {
      deployments: active.rows.map((row) => ({
        project: toProject(row),
        deployment: toDeployment(row.deployment),
      })),
      deletions: deleting.rows.map(toProject),
      settled: settled.rows.map((row) => ({
        project: toProject(row),
        live: toDeployment(row.live),
      })),
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

  async tryLockController(): Promise<boolean> {
    if (this.lockClient) {
      try {
        await this.lockClient.query("SELECT 1");
        return true;
      } catch {
        // The connection (and with it the lock) is gone; try to get it again.
        this.lockClient.release(true);
        this.lockClient = null;
      }
    }
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [CONTROLLER_LOCK_ID],
      );
      if (!rows[0]?.locked) {
        client.release();
        return false;
      }
      // Errors on a checked-out client would otherwise crash the process.
      client.on("error", () => {});
      this.lockClient = client;
      return true;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async unlockController(): Promise<void> {
    const client = this.lockClient;
    this.lockClient = null;
    if (!client) return;
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [CONTROLLER_LOCK_ID]);
      client.release();
    } catch {
      client.release(true);
    }
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

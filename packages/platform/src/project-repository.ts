import { randomUUID } from "node:crypto";
import {
  canTransition,
  type DeploymentStatus,
  type ProjectSource,
} from "@cloud-platform/contracts";
import type pg from "pg";
import type { DatabasePool } from "./database.js";

export interface ProjectRecord {
  id: string;
  name: string;
  source: ProjectSource;
  containerPort: number;
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
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ProjectWithLatest {
  project: ProjectRecord;
  latest: DeploymentRecord | null;
}

export interface NewProject {
  name: string;
  source: ProjectSource;
  containerPort: number;
  healthCheckPath: string;
  env: Record<string, string>;
}

export interface ProjectLimits {
  /** Inclusive range of ports handed out to projects. */
  portRange: { min: number; max: number };
  maxProjects: number;
}

export class NameTakenError extends Error {
  constructor(name: string) {
    super(`A project named "${name}" already exists.`);
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

export interface TransitionFields {
  imageRef?: string;
  failureReason?: string;
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
  container_port: number;
  health_check_path: string;
  env: Record<string, string>;
  assigned_port: number;
  desired_state: "running" | "stopped";
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DeploymentRow {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  image_ref: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    // Only image sources exist so far; repository sources arrive with Phase 2.
    source: { type: "image", image: row.image ?? "" },
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
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const PROJECT_COLUMNS = `p.id, p.name, p.source_type, p.image, p.container_port, p.health_check_path,
  p.env, p.assigned_port, p.desired_state, p.deleted_at, p.created_at, p.updated_at`;
const DEPLOYMENT_COLUMNS = `d.id, d.project_id, d.status, d.image_ref, d.failure_reason,
  d.created_at, d.updated_at, d.started_at, d.finished_at`;

/** Prefixes deployment columns with `d_` so they can share a row with project columns. */
const PREFIXED_DEPLOYMENT_COLUMNS = DEPLOYMENT_COLUMNS.split(",")
  .map((column) => column.trim())
  .map((column) => `${column} AS d_${column.slice(2)}`)
  .join(", ");

type JoinedRow = ProjectRow & { [K in keyof DeploymentRow as `d_${K}`]: DeploymentRow[K] | null };

function splitJoined(row: JoinedRow): ProjectWithLatest {
  const latest =
    row.d_id === null
      ? null
      : toDeployment({
          id: row.d_id,
          project_id: row.d_project_id!,
          status: row.d_status!,
          image_ref: row.d_image_ref,
          failure_reason: row.d_failure_reason,
          created_at: row.d_created_at!,
          updated_at: row.d_updated_at!,
          started_at: row.d_started_at,
          finished_at: row.d_finished_at,
        });
  return { project: toProject(row), latest };
}

/** Serialises project creation so the project limit and port choice cannot race. */
const CREATE_LOCK_ID = 7_241_999;

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

      let projectRow: ProjectRow;
      try {
        const { rows } = await client.query<ProjectRow>(
          `INSERT INTO projects AS p (id, name, source_type, image, container_port,
             health_check_path, env, assigned_port)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${PROJECT_COLUMNS}`,
          [
            randomUUID(),
            input.name,
            input.source.type,
            input.source.image,
            input.containerPort,
            input.healthCheckPath,
            JSON.stringify(input.env),
            port,
          ],
        );
        projectRow = rows[0]!;
      } catch (error) {
        if ((error as { code?: string; constraint?: string }).constraint === "projects_name_key") {
          throw new NameTakenError(input.name);
        }
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
    const { rows } = await this.pool.query<JoinedRow>(
      `SELECT ${PROJECT_COLUMNS}, ${PREFIXED_DEPLOYMENT_COLUMNS}
         FROM projects p
         LEFT JOIN LATERAL (
           SELECT * FROM deployments WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1
         ) d ON true
        ORDER BY p.created_at DESC`,
    );
    return rows.map(splitJoined);
  }

  async get(id: string): Promise<ProjectWithLatest | null> {
    const { rows } = await this.pool.query<JoinedRow>(
      `SELECT ${PROJECT_COLUMNS}, ${PREFIXED_DEPLOYMENT_COLUMNS}
         FROM projects p
         LEFT JOIN LATERAL (
           SELECT * FROM deployments WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1
         ) d ON true
        WHERE p.id = $1`,
      [id],
    );
    return rows[0] ? splitJoined(rows[0]) : null;
  }

  async markDeleted(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE projects SET deleted_at = coalesce(deleted_at, now()), updated_at = now()
        WHERE id = $1`,
      [id],
    );
    return rowCount === 1;
  }

  async findWork(): Promise<ControllerWork> {
    const [active, deleting] = await Promise.all([
      this.pool.query<JoinedRow>(
        `SELECT ${PROJECT_COLUMNS}, ${PREFIXED_DEPLOYMENT_COLUMNS}
           FROM deployments d JOIN projects p ON p.id = d.project_id
          WHERE d.status IN ('pending', 'building', 'deploying') AND p.deleted_at IS NULL
          ORDER BY d.created_at`,
      ),
      this.pool.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.deleted_at IS NOT NULL`,
      ),
    ]);
    return {
      deployments: active.rows.map((row) => {
        const { project, latest } = splitJoined(row);
        return { project, deployment: latest! };
      }),
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
            WHERE status = 'live'
              AND project_id = (SELECT project_id FROM deployments WHERE id = $1)`,
            [id],
          );
        }
        const { rows } = await client.query<DeploymentRow>(
          `UPDATE deployments AS d
            SET status = $3,
                image_ref = coalesce($4, image_ref),
                failure_reason = coalesce($5, failure_reason)
          WHERE id = $1 AND status = $2
          RETURNING ${DEPLOYMENT_COLUMNS}`,
          [id, from, to, fields.imageRef ?? null, fields.failureReason ?? null],
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

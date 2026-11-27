import { z } from "zod";

// ---------------------------------------------------------------------------
// Deployment lifecycle
// ---------------------------------------------------------------------------

export const DEPLOYMENT_STATUSES = [
  "pending",
  "building",
  "deploying",
  "live",
  "failed",
  "superseded",
  "cancelled",
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * Allowed status changes. The database enforces the same rules with a trigger
 * (see packages/platform/migrations), so a bug cannot move a deployment
 * backwards.
 */
export const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  pending: ["building", "deploying", "failed", "cancelled"],
  building: ["deploying", "failed", "cancelled"],
  deploying: ["live", "failed", "cancelled"],
  live: ["superseded"],
  failed: [],
  superseded: [],
  cancelled: [],
};

export const ACTIVE_DEPLOYMENT_STATUSES = ["pending", "building", "deploying"] as const;

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return DEPLOYMENT_TRANSITIONS[from].includes(to);
}

export function isActiveDeployment(status: DeploymentStatus): boolean {
  return (ACTIVE_DEPLOYMENT_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Lowercase DNS label, 3-30 characters: usable later as a subdomain. */
export const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;

/** Upper-case environment variable names, as most runtimes expect. */
export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAX_ENV_VARS = 50;
export const MAX_ENV_VALUE_LENGTH = 4_096;

const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const REGISTRY = "(?:[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*(?::[0-9]+)?/)";
const TAG = "(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})";
const DIGEST = "(?:@sha256:[a-f0-9]{64})";

/** A Docker image reference: [registry/]path[:tag][@sha256:digest]. */
export const IMAGE_REFERENCE_PATTERN = new RegExp(
  `^${REGISTRY}?${COMPONENT}(?:/${COMPONENT})*${TAG}?${DIGEST}?$`,
);

/**
 * Expand a short image reference into a fully qualified one, as Docker does:
 * `nginx` -> `docker.io/library/nginx:latest`. Podman and other engines may
 * not resolve short names the same way, so the platform always passes the
 * full reference.
 */
export function normalizeImageReference(reference: string): string {
  const slash = reference.indexOf("/");
  const first = slash === -1 ? "" : reference.slice(0, slash);
  const hasRegistry =
    slash !== -1 && (first.includes(".") || first.includes(":") || first === "localhost");
  let full = hasRegistry ? reference : `docker.io/${reference}`;
  if (!hasRegistry && slash === -1) full = `docker.io/library/${reference}`;

  const lastSegment = full.slice(full.lastIndexOf("/") + 1);
  const hasTagOrDigest = lastSegment.includes(":") || full.includes("@");
  return hasTagOrDigest ? full : `${full}:latest`;
}

const imageSourceSchema = z.object({
  type: z.literal("image"),
  image: z
    .string()
    .trim()
    .min(1, "source.image is required.")
    .max(255, "source.image must be at most 255 characters.")
    .regex(
      IMAGE_REFERENCE_PATTERN,
      "source.image is not a valid image reference, e.g. nginx:alpine.",
    ),
});

/** Public GitHub repositories only: https://github.com/<owner>/<repo>. */
export const GITHUB_REPO_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** Branch names: git ref characters only, and never an option-like leading "-". */
export const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;

/** A relative path inside the repository, without "..". */
export const REPO_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;

/** The canonical form of a GitHub repository URL, or null if it is not one. */
export function normalizeRepoUrl(url: string): string | null {
  const match = GITHUB_REPO_PATTERN.exec(url.trim());
  if (!match) return null;
  const repo = match[2]!;
  if (repo === "." || repo === "..") return null;
  return `https://github.com/${match[1]}/${repo}`;
}

/** A project name derived from a repository: https://github.com/a/My_App -> my-app. */
export function projectNameFromRepo(repoUrl: string): string {
  const repo = (normalizeRepoUrl(repoUrl) ?? repoUrl).split("/").pop() ?? "";
  let name = repo
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  if (name.length < 3) name = `app-${name}`.replace(/-+$/, "").padEnd(3, "0");
  return name;
}

const branchSchema = z
  .string()
  .trim()
  .regex(BRANCH_PATTERN, "source.branch is not a valid branch name.");
const dockerfilePathSchema = z
  .string()
  .trim()
  .regex(REPO_PATH_PATTERN, "source.dockerfilePath must be a path inside the repository.");
const composeServiceSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, "source.composeService is not a valid service name.");

const repoSourceSchema = z.object({
  type: z.literal("repo"),
  repoUrl: z
    .string()
    .trim()
    .min(1, "source.repoUrl is required.")
    .refine((url) => normalizeRepoUrl(url) !== null, {
      message:
        "source.repoUrl must be a public GitHub repository, e.g. https://github.com/owner/repo.",
    })
    .transform((url) => normalizeRepoUrl(url)!),
  /** Default: the repository's default branch. */
  branch: branchSchema.optional(),
  /** Default: found automatically. Setting it skips the compose file. */
  dockerfilePath: dockerfilePathSchema.optional(),
  /**
   * Compose apps: the service that gets the URL. Default: the one that
   * publishes a port.
   */
  composeService: composeServiceSchema.optional(),
});

/** A GitHub repository (the main way to deploy) or a ready-made Docker image. */
export const projectSourceSchema = z.discriminatedUnion(
  "type",
  [repoSourceSchema, imageSourceSchema],
  {
    errorMap: (issue, context) =>
      issue.code === "invalid_union_discriminator"
        ? { message: 'source.type must be "repo" or "image".' }
        : { message: context.defaultError },
  },
);
export type ProjectSource = z.infer<typeof projectSourceSchema>;
export type RepoSource = z.infer<typeof repoSourceSchema>;
export type ImageSource = z.infer<typeof imageSourceSchema>;

export const envSchema = z
  .record(
    z.string().regex(ENV_KEY_PATTERN, "Environment variable names must look like MY_VAR."),
    z
      .string()
      .max(
        MAX_ENV_VALUE_LENGTH,
        `Environment values must be at most ${MAX_ENV_VALUE_LENGTH} characters.`,
      ),
  )
  .refine((env) => Object.keys(env).length <= MAX_ENV_VARS, {
    message: `At most ${MAX_ENV_VARS} environment variables are allowed.`,
  });

const portSchema = z.coerce
  .number({ invalid_type_error: "containerPort must be a number." })
  .int("containerPort must be a whole number.")
  .min(1, "containerPort must be between 1 and 65535.")
  .max(65_535, "containerPort must be between 1 and 65535.");

const healthCheckPathSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^\/[A-Za-z0-9._~\-/?=&%]*$/, "healthCheckPath must start with / and be a URL path.");

export const createProjectRequestSchema = z
  .object({
    /** Default for repositories: derived from the repository name. */
    name: z
      .string()
      .trim()
      .regex(
        PROJECT_NAME_PATTERN,
        "name must be 3-30 characters: lowercase letters, digits and hyphens, starting with a letter.",
      )
      .optional(),
    source: projectSourceSchema,
    /** Default for repositories: the EXPOSE port of the Dockerfile. Required for images. */
    containerPort: portSchema.optional(),
    healthCheckPath: healthCheckPathSchema.default("/"),
    env: envSchema.default({}),
  })
  .superRefine((value, context) => {
    if (value.source.type === "image" && value.containerPort === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["containerPort"],
        message: "containerPort is required for image deployments.",
      });
    }
    if (value.source.type === "image" && value.name === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "name is required.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    name: value.name ?? projectNameFromRepo((value.source as RepoSource).repoUrl),
    containerPort: value.containerPort ?? null,
  }));
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;
export type CreateProjectInput = z.output<typeof createProjectRequestSchema>;

/**
 * Change a project's settings. Every field is optional; null clears a
 * repository setting back to "automatic". Changes apply to the next
 * deployment (redeploy, rollback or start after a crash).
 */
export const updateProjectRequestSchema = z
  .object({
    containerPort: portSchema.nullable().optional(),
    healthCheckPath: healthCheckPathSchema.optional(),
    env: envSchema.optional(),
    branch: branchSchema.nullable().optional(),
    dockerfilePath: dockerfilePathSchema.nullable().optional(),
    composeService: composeServiceSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message:
      "Nothing to change: set containerPort, healthCheckPath, env, branch, dockerfilePath or composeService.",
  });
export type UpdateProjectRequest = z.input<typeof updateProjectRequestSchema>;
export type UpdateProjectInput = z.output<typeof updateProjectRequestSchema>;

export const rollbackRequestSchema = z.object({
  deploymentId: z.string().uuid("deploymentId must be a deployment ID."),
});
export type RollbackRequest = z.input<typeof rollbackRequestSchema>;

/** The port the app gets as $PORT, unless the user sets PORT themselves. */
export const PORT_ENV_VAR = "PORT";

// ---------------------------------------------------------------------------
// Compose apps (stored with each deployment)
// ---------------------------------------------------------------------------

/** A named volume of a compose service; the data survives redeploys. */
export interface VolumeMount {
  /** Volume name from the compose file. */
  name: string;
  target: string;
  readOnly: boolean;
}

/** One service of a compose file, ready to run. */
export interface ServiceSpec {
  /** Service name; other services reach it by this host name. */
  name: string;
  image: string;
  /** Pull the image first (registry images); false for images built here. */
  pull: boolean;
  command: string[] | null;
  entrypoint: string[] | null;
  env: Record<string, string>;
  volumes: VolumeMount[];
  /** Anonymous volumes (container paths); removed with the container. */
  tmpVolumes: string[];
  workingDir: string | null;
  user: string | null;
  /** Docker restart policy name. */
  restart: "no" | "always" | "unless-stopped" | "on-failure";
  dependsOn: string[];
}

/** What a compose file deploys: its services and the one that gets the URL. */
export interface ComposePlan {
  /** Compose file, relative to the repository root. */
  file: string;
  publicService: string;
  /** All services, in start order (dependencies first). */
  services: ServiceSpec[];
}

// ---------------------------------------------------------------------------
// API responses
// ---------------------------------------------------------------------------

export interface DeploymentView {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  /** Image that runs (or ran): pulled for image sources, built for repositories. */
  imageRef: string | null;
  /** Repository commit that was built. */
  commitSha: string | null;
  /** Dockerfile (or compose file) that was used, relative to the repository root. */
  dockerfilePath: string | null;
  /** Compose apps: the compose file used, its services, and the one with the URL. */
  compose: { file: string; publicService: string; services: string[] } | null;
  /** Port the app listens on in this deployment (given, or detected from EXPOSE). */
  containerPort: number | null;
  /** Set when this deployment rolls back to an earlier one (no build). */
  rollbackOf: string | null;
  /** Safe, human-readable reason when status is "failed". */
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * What the dashboard shows for a project: its latest deployment's status,
 * "stopped" when stopped by the user or for being idle, or "deleting".
 */
export type ProjectStatus = DeploymentStatus | "stopped" | "deleting";

export type DesiredState = "running" | "stopped";
/** Why a project is stopped: by its user, or automatically after being idle. */
export type StopReason = "user" | "idle";

export interface ProjectView {
  id: string;
  name: string;
  source: ProjectSource;
  /** Port given by the user; null means "detect from the Dockerfile". */
  containerPort: number | null;
  healthCheckPath: string;
  env: Record<string, string>;
  /** Public URL of the app. It serves the live deployment, if there is one. */
  url: string;
  status: ProjectStatus;
  /** Whether the app should run. The controller makes the containers match. */
  desiredState: DesiredState;
  stopReason: StopReason | null;
  /** Last time the app had network traffic (or was started). */
  lastActiveAt: string;
  latestDeployment: DeploymentView | null;
  /** The deployment serving the URL. May be older than latestDeployment. */
  liveDeployment: DeploymentView | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectResponse {
  project: ProjectView;
  deployment: DeploymentView;
}

export interface ListProjectsResponse {
  projects: ProjectView[];
}

export interface ListDeploymentsResponse {
  deployments: DeploymentView[];
}

export interface BuildLogResponse {
  deploymentId: string;
  status: DeploymentStatus;
  /** Build output so far; the start is cut when it exceeds the size limit. */
  log: string;
  truncated: boolean;
}

export interface RuntimeLogResponse {
  projectId: string;
  /** Compose service the log is from; null for single-container apps. */
  service: string | null;
  /** All services of a compose app, for picking another log. */
  services: string[];
  /** The last lines the app wrote to stdout and stderr, with timestamps. */
  log: string;
}

export const API_ERROR_CODES = [
  "INVALID_INPUT",
  "NAME_TAKEN",
  "PROJECT_LIMIT_REACHED",
  "NO_FREE_PORT",
  "PROJECT_NOT_FOUND",
  "DEPLOYMENT_NOT_FOUND",
  "DEPLOYMENT_IN_PROGRESS",
  "NO_LIVE_DEPLOYMENT",
  "ROLLBACK_NOT_POSSIBLE",
  "NOT_FOUND",
  "INTERNAL_ERROR",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorResponse {
  error: { code: ApiErrorCode; message: string };
}

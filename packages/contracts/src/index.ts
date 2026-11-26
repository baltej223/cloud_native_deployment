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

/** Phase 1 supports Docker image sources; repository sources arrive in Phase 2. */
export const projectSourceSchema = z.discriminatedUnion("type", [imageSourceSchema], {
  errorMap: (issue, context) =>
    issue.code === "invalid_union_discriminator"
      ? { message: 'source.type must be "image".' }
      : { message: context.defaultError },
});
export type ProjectSource = z.infer<typeof projectSourceSchema>;

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

export const createProjectRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(
      PROJECT_NAME_PATTERN,
      "name must be 3-30 characters: lowercase letters, digits and hyphens, starting with a letter.",
    ),
  source: projectSourceSchema,
  containerPort: z.coerce
    .number({ invalid_type_error: "containerPort must be a number." })
    .int("containerPort must be a whole number.")
    .min(1, "containerPort must be between 1 and 65535.")
    .max(65_535, "containerPort must be between 1 and 65535."),
  healthCheckPath: z
    .string()
    .trim()
    .max(200)
    .regex(/^\/[A-Za-z0-9._~\-/?=&%]*$/, "healthCheckPath must start with / and be a URL path.")
    .default("/"),
  env: envSchema.default({}),
});
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;
export type CreateProjectInput = z.output<typeof createProjectRequestSchema>;

// ---------------------------------------------------------------------------
// API responses
// ---------------------------------------------------------------------------

export interface DeploymentView {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  /** Fully qualified image that runs (or ran) for this deployment. */
  imageRef: string | null;
  /** Safe, human-readable reason when status is "failed". */
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What the dashboard shows for a project: its latest deployment, or deletion. */
export type ProjectStatus = DeploymentStatus | "deleting";

export interface ProjectView {
  id: string;
  name: string;
  source: ProjectSource;
  containerPort: number;
  healthCheckPath: string;
  env: Record<string, string>;
  /** Public URL of the app. It works while the latest deployment is live. */
  url: string;
  status: ProjectStatus;
  latestDeployment: DeploymentView | null;
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

export const API_ERROR_CODES = [
  "INVALID_INPUT",
  "NAME_TAKEN",
  "PROJECT_LIMIT_REACHED",
  "NO_FREE_PORT",
  "PROJECT_NOT_FOUND",
  "NOT_FOUND",
  "INTERNAL_ERROR",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorResponse {
  error: { code: ApiErrorCode; message: string };
}

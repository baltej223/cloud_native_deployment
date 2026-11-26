/**
 * Drivers hide where apps run. The deployment controller only talks to these
 * interfaces; there is a local implementation (Docker or Podman on the same
 * machine) and, later, a cloud one.
 */

/** Everything needed to run one version of a project's app. */
export interface AppSpec {
  projectId: string;
  deploymentId: string;
  /** Fully qualified image reference, e.g. docker.io/library/nginx:alpine. */
  image: string;
  containerPort: number;
  env: Record<string, string>;
  /** Port on which the platform exposes the app to users. */
  publicPort: number;
  /** Pull the image first (registry images); false for images built here. */
  pull: boolean;
}

export type AppState =
  | { state: "missing" }
  | {
      /** "starting": created but not running yet; "restarting": crashed and being restarted. */
      state: "starting" | "running" | "restarting" | "exited";
      /** Deployment whose version this container runs, from its labels. */
      deploymentId: string | null;
      exitCode: number | null;
      restartCount: number;
      /** When the container last started; null if it never has. */
      startedAt: Date | null;
    };

/** Runs, inspects and removes app containers. Every method is safe to repeat. */
export interface Runtime {
  /** One-time setup at startup, such as creating the apps network. */
  prepare(): Promise<void>;
  /** Resolve if the container engine is reachable. */
  ping(): Promise<void>;
  /**
   * Fetch the image and replace the project's app with the given version.
   * Throws DeployError with a user-facing reason when that fails.
   */
  deploy(spec: AppSpec): Promise<void>;
  inspect(projectId: string): Promise<AppState>;
  /** Remove the project's app. Succeeds if it is already gone. */
  remove(projectId: string): Promise<void>;
  /** Delete an image built for the project. Succeeds if it is already gone. */
  removeImage(image: string): Promise<void>;
}

export interface AppTarget {
  projectId: string;
  containerPort: number;
  publicPort: number;
  healthCheckPath: string;
}

/** Gives apps a URL and checks that they answer on it. */
export interface Router {
  urlFor(project: { name: string; publicPort: number }): string;
  /** True if the app answers HTTP requests (any status below 500). */
  probe(target: AppTarget): Promise<boolean>;
}

export interface BuildRequest {
  projectId: string;
  deploymentId: string;
  /** Canonical https://github.com/<owner>/<repo> URL. */
  repoUrl: string;
  /** Default: the repository's default branch. */
  branch?: string;
  /** Default: discovered. */
  dockerfilePath?: string;
  /** Aborts the build (project deleted, timeout, shutdown). */
  signal: AbortSignal;
  /** Receives build output as it happens. */
  onLog: (text: string) => void;
}

export interface BuildResult {
  /** Image reference the runtime can start without pulling. */
  image: string;
  commitSha: string;
  /** Dockerfile used, relative to the repository root. */
  dockerfilePath: string;
  /** Build context, relative to the repository root ("." for the root). */
  contextPath: string;
  /** First port of the final stage's EXPOSE, if any. */
  exposedPort: number | null;
}

/** Turns a repository into a runnable image. */
export interface Builder {
  /** Throws DeployError with a user-facing reason when the build fails. */
  build(request: BuildRequest): Promise<BuildResult>;
}

/** A deployment step failed for a reason that is safe to show to the user. */
export class DeployError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "DeployError";
  }
}

/** Name of the container (or service) that runs a project's app. */
export const appName = (projectId: string) => `cp-app-${projectId}`;

export const LABELS = {
  project: "cloud-platform.project",
  deployment: "cloud-platform.deployment",
} as const;

import type {
  ApiErrorResponse,
  BuildLogResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  DeploymentView,
  ListDeploymentsResponse,
  ListProjectsResponse,
  ProjectSource,
  ProjectStatus,
  ProjectView,
  RuntimeLogResponse,
  UpdateProjectRequest,
} from "@cloud-platform/contracts";

/** Empty means "same origin" (the platform's load balancer routes the API paths). */
export const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as Partial<ApiErrorResponse>;
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function call<T>(path: string, init: RequestInit, fallback: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      cache: "no-store",
      credentials: "include",
      ...init,
    });
  } catch {
    throw new Error("Cannot reach the platform API. Is it running?");
  }
  if (response.status === 401 && !path.startsWith("/auth/") && typeof window !== "undefined") {
    window.location.assign("/login");
    throw new Error("Sign in first.");
  }
  if (!response.ok) throw new Error(await readError(response, fallback));
  return (await response.json()) as T;
}

export const listProjects = async () =>
  (await call<ListProjectsResponse>("/projects", {}, "Could not load projects.")).projects;

export const getProject = (id: string) =>
  call<ProjectView>(`/projects/${id}`, {}, "Could not load the project.");

export const createProject = (request: CreateProjectRequest) =>
  call<CreateProjectResponse>(
    "/projects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
    "Could not create the project.",
  );

export const deleteProject = (id: string) =>
  call<{ id: string; status: "deleting" }>(
    `/projects/${id}`,
    { method: "DELETE" },
    "Could not delete the project.",
  );

export const redeployProject = (id: string) =>
  call<DeploymentView>(
    `/projects/${id}/deployments`,
    { method: "POST" },
    "Could not start a new deployment.",
  );

const jsonRequest = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const updateProject = (id: string, changes: UpdateProjectRequest) =>
  call<ProjectView>(
    `/projects/${id}`,
    jsonRequest("PATCH", changes),
    "Could not save the settings.",
  );

export const stopProject = (id: string) =>
  call<ProjectView>(`/projects/${id}/stop`, { method: "POST" }, "Could not stop the app.");

export const startProject = (id: string) =>
  call<ProjectView>(`/projects/${id}/start`, { method: "POST" }, "Could not start the app.");

export const rollbackProject = (id: string, deploymentId: string) =>
  call<DeploymentView>(
    `/projects/${id}/rollback`,
    jsonRequest("POST", { deploymentId }),
    "Could not roll back.",
  );

export const getRuntimeLogs = (id: string, service: string | null, tail = 300) =>
  call<RuntimeLogResponse>(
    `/projects/${id}/logs?tail=${tail}${service ? `&service=${encodeURIComponent(service)}` : ""}`,
    {},
    "Could not load the app's logs.",
  );

export interface Session {
  required: boolean;
  signedIn: boolean;
}

export const getSession = () => call<Session>("/auth/session", {}, "Could not check the session.");

export const login = (password: string) =>
  call<Session>("/auth/login", jsonRequest("POST", { password }), "Could not sign in.");

export const logout = () =>
  call<Session>("/auth/logout", { method: "POST" }, "Could not sign out.");

export const listDeployments = async (projectId: string) =>
  (
    await call<ListDeploymentsResponse>(
      `/projects/${projectId}/deployments`,
      {},
      "Could not load deployments.",
    )
  ).deployments;

export const getBuildLog = (deploymentId: string) =>
  call<BuildLogResponse>(`/deployments/${deploymentId}/logs`, {}, "Could not load the build log.");

/** Short description of where a project comes from: "owner/repo" or the image. */
export function describeSource(source: ProjectSource): string {
  if (source.type === "image") return source.image.replace(/^docker\.io\/(library\/)?/, "");
  const repo = source.repoUrl.replace(/^https:\/\/github\.com\//, "");
  return source.branch ? `${repo} @ ${source.branch}` : repo;
}

/** Statuses that will change on their own, so the dashboard keeps polling. */
export const isSettling = (status: ProjectStatus) =>
  status === "pending" || status === "building" || status === "deploying" || status === "deleting";

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  pending: "Queued",
  building: "Building",
  deploying: "Deploying",
  live: "Live",
  failed: "Failed",
  superseded: "Replaced",
  cancelled: "Cancelled",
  stopped: "Stopped",
  deleting: "Deleting",
};

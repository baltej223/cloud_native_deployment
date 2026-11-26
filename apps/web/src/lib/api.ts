import type {
  ApiErrorResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  ListProjectsResponse,
  ProjectStatus,
  ProjectView,
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
    response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new Error("Cannot reach the platform API. Is it running?");
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
  deleting: "Deleting",
};

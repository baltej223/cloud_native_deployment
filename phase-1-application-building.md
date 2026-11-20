# Phase 1: Build the platform locally

## Goal

Build and run the first end-to-end version of the deployment platform on a developer machine. A user enters a Docker image and a port in the dashboard, the platform runs it as a container and shows a URL that serves the app.

At the end of this phase:

- The dashboard, API and PostgreSQL run through Docker Compose.
- Creating a project returns immediately; the deployment moves through its states in the background and ends `live` or `failed`.
- The app's URL (for example `http://localhost:8001`) serves the deployed container.
- The controller code talks to interfaces (`Runtime`, `Router`), so the AWS versions in Phase 4 plug in without rewriting it.

This phase is for building locally. It does not include GitHub repository builds (Phase 2), the full app lifecycle (Phase 3), AWS resources, authentication or CI/CD changes.

## Local stack

| Component | Local choice | Responsibility |
|---|---|---|
| Dashboard | Next.js with TypeScript | Create projects, list them, show status and URL |
| API | Node.js with TypeScript (Express) | Validate requests, store projects and deployments, run the controller |
| Database | PostgreSQL container, or Supabase | Projects, deployments, desired state |
| Container runtime | Docker or Podman on the host, through its API socket | Pull images and run user apps |
| Local orchestration | Docker Compose | Start and connect the platform services |

The API reaches the host's container engine through its socket, mounted into the API container. This gives the API full control of the host's containers, which is acceptable for local development only. On AWS the API uses ECS instead and never has such access.

## Scope of the first deployment

Phase 1 supports one source type: a public Docker image.

Example request:

```json
{
  "name": "hello-nginx",
  "source": { "type": "image", "image": "nginx:alpine" },
  "containerPort": 80,
  "env": { "GREETING": "hi" }
}
```

Example response (`201 Created`):

```json
{
  "project": {
    "id": "…",
    "name": "hello-nginx",
    "url": "http://localhost:8001",
    "status": "pending"
  },
  "deployment": { "id": "…", "status": "pending" }
}
```

The API does not pull or start anything inside the request. It records the desired state and returns; the controller does the work.

## Repository layout

```text
cloud_project/
├── apps/
│   ├── web/                 # Next.js dashboard
│   └── api/                 # HTTP API and deployment controller
├── packages/
│   ├── contracts/           # Shared request/response schemas and state machine
│   ├── platform/            # Database, config, logging
│   └── drivers/             # Builder/Runtime/Router interfaces + local (and later AWS) drivers
├── infra/
│   └── aws/                 # CloudFormation (updated in Phase 4)
├── compose.yaml
├── .env.example
└── README.md
```

`apps/worker`, `packages/job-processing` and the LocalStack setup from the earlier design are removed.

## Deployment flow

1. The browser sends `POST /projects`.
2. The API validates the input, assigns a free port from the range 8001-8050, and inserts the project and a deployment with status `pending` in one transaction.
3. The API returns `201` with the project, its URL and the deployment.
4. The controller loop picks up the `pending` deployment and sets it to `deploying`.
5. The controller pulls the image, removes any older container for the project, and starts a new container named `cp-app-<project id>` with the env vars and the port mapping `<assigned port>:<container port>`.
6. The controller checks `http://<host>:<assigned port><health path>` until it answers (any status below 500), with a timeout.
7. The deployment becomes `live`; or `failed` with a reason such as "image not found", "container exited with code 1" or "no response on port 80 within 120 s".
8. The dashboard polls `GET /projects/:id` and shows the status, the reason on failure and the URL when live.

The database is the source of truth. If the API restarts halfway, the controller finds the unfinished deployment and continues from its current state.

## Data model

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9-]{1,28}[a-z0-9]$'),
  source_type TEXT NOT NULL CHECK (source_type IN ('image', 'repo')),
  image TEXT,
  container_port INTEGER NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  health_check_path TEXT NOT NULL DEFAULT '/',
  env JSONB NOT NULL DEFAULT '{}',
  assigned_port INTEGER NOT NULL UNIQUE,
  desired_state TEXT NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running', 'stopped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deployments (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'building', 'deploying', 'live', 'failed', 'superseded', 'cancelled')),
  image_ref TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX deployments_project_created_idx ON deployments (project_id, created_at DESC);
```

Use migrations. Replace the `jobs` migrations with these (the old data is throwaway). Add a trigger that rejects invalid status transitions, as the earlier `jobs` table did.

## API contract (Phase 1)

### `POST /projects`

- Validate the name (lowercase letters, digits and hyphens, 3-30 characters), the image reference, the port and env var keys (`^[A-Z_][A-Z0-9_]*$`).
- Return `409` if the name is taken, and `409` with a clear message if no port is free.
- Return `201` with the project, URL and first deployment.

### `GET /projects` and `GET /projects/:id`

Return each project with its URL and latest deployment (status, failure reason, timestamps). Return `404` for unknown IDs.

### `DELETE /projects/:id`

Mark the project for deletion and return `202`. The controller removes the container and then the row, which frees the port.

### Health endpoints

- `GET /health/live`: the process is running.
- `GET /health/ready`: the database and the container engine are reachable.

## Controller behavior

The controller is a loop in the API process that runs every few seconds:

1. Load deployments in `pending` or `deploying`, and projects marked for deletion.
2. For each, call the driver for the next step and save the new state.
3. Catch errors per item; one broken deployment must not stop the loop.
4. Log each step with the project and deployment IDs.

Every step must be safe to repeat. "Start container" first removes an existing container with the same name; "remove container" treats "not found" as success.

## Driver interfaces

```ts
interface Runtime {
  deploy(app: { projectId: string; image: string; containerPort: number; env: Record<string, string>; hostPort: number }): Promise<void>;
  status(projectId: string): Promise<{ state: "starting" | "running" | "exited" | "missing"; exitCode?: number }>;
  remove(projectId: string): Promise<void>;
}

interface Router {
  urlFor(project: { name: string; assignedPort: number }): string;
  healthy(project: { assignedPort: number; healthCheckPath: string }): Promise<boolean>;
}
```

Phase 1 implements both with the Docker Engine API (`dockerode` or plain HTTP over the socket). Phase 2 adds `Builder`. Phase 4 adds the AWS implementations.

## Local environment

Add to `.env.example`:

```dotenv
PLATFORM_DRIVER=local
DOCKER_SOCKET=/var/run/docker.sock   # Podman: $XDG_RUNTIME_DIR/podman/podman.sock
APP_PORT_RANGE=8001-8050
APP_HOST=localhost                   # host name used in app URLs
MAX_PROJECTS=10
```

Compose changes:

- Remove `localstack`, its init script and the `worker` service.
- Mount the container engine socket into `api`, and publish nothing extra: user app ports are published by the containers the API starts.
- Keep `postgres` with the `USE_SUPABASE` switch.

The API container reaches user apps for health checks through the host (`host.docker.internal` or `host.containers.internal`), configured as `APP_HEALTH_HOST`.

## Implementation sequence

1. Add the new migrations, contracts and state machine; delete the job, worker, queue and S3 code.
2. Add the `drivers` package with the interfaces and the local Docker implementation.
3. Implement the API routes and port assignment.
4. Implement the controller loop.
5. Build the dashboard pages: project list, new project form, project detail with polling.
6. Update Compose, `.env.example` and the README.
7. Run the full flow with `nginx:alpine` and a broken image, then delete both.

## Definition of done

Phase 1 is complete when a developer can:

- Start the platform with one documented command.
- Deploy `nginx:alpine` on port 80 from the dashboard and open its URL.
- Deploy a nonexistent image and see `failed` with a useful reason.
- Restart the platform and still see the projects, with live apps still serving.
- Delete a project and see its container gone and its port free again.
- Follow one deployment through the logs using its ID.

## Deliberately deferred

Repository builds, redeploy and rollback, runtime logs, auto-stop, AWS drivers, the deploy token, per-app dashboards and alarms belong to later phases.

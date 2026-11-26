# Cloud Deploy

A small platform-as-a-service: give it a Docker image (and, from Phase 2, a GitHub repository) plus the port the app listens on, and it runs the app and gives you a URL.

- Design: [cloud_platform_baseline.md](cloud_platform_baseline.md)
- Plan: [phase-wise-implementation.md](phase-wise-implementation.md)
- API: [docs/API.md](docs/API.md)

**Status:** Phase 1 (deploy a Docker image locally) is implemented.

## How it works

```text
Browser ── Next.js dashboard (:3000)
              │
              ▼
          Express API (:3001) ── PostgreSQL: projects + deployments (desired state)
              │
              └── Deployment controller (loop inside the API)
                    └── Docker / Podman API socket
                          ├── cp-app-<project id>  → http://localhost:8001
                          ├── cp-app-<project id>  → http://localhost:8002
                          └── …
```

1. `POST /projects` validates the request, picks a free port (8001-8050) and stores the project with a `pending` deployment. It returns immediately.
2. The controller, which checks the database every 2 seconds, moves the deployment to `deploying`, pulls the image and starts a container that publishes the app on the project's port.
3. Once the app answers HTTP on its health check path, the deployment becomes `live`. If the image does not exist, the container crashes, or the app never answers (120 s), it becomes `failed` with a readable reason, and the container is removed.
4. Deleting a project removes its container, then its record, which frees the name and port.

There is no queue: the database records what should exist, and the controller makes the container engine match it. Every step is safe to repeat, so restarting the platform resumes unfinished deployments.

**Isolation:** apps run on their own network (`cloud-platform-apps`), separate from the database. Each app is limited to 512 MB of memory and half a CPU, and gets no platform credentials.

## Run it locally

Requirements: Docker with Compose, or Podman plus `docker compose` (Compose talks to Podman through its socket).

```bash
cp .env.example .env          # optional; every value has a default
docker compose up --build
```

Open http://localhost:3000, enter a name, an image such as `nginx:alpine` and port `80`, and press **Deploy**. When the project shows **Live**, open its URL.

Things to try:

| Image                 | Port | Result                                      |
| --------------------- | ---- | ------------------------------------------- |
| `nginx:alpine`        | 80   | Live; nginx welcome page                    |
| `traefik/whoami`      | 80   | Live; prints request details                |
| `nginx:alpine`        | 9999 | Failed after 120 s: nothing answers on 9999 |
| `no-such/image-xyz:1` | 80   | Failed: image not found                     |

### With Podman (rootless)

Compose needs a Docker-compatible socket. Start Podman's API service for your user, then point both Compose and the platform at it:

```bash
podman system service --time=0 unix://$XDG_RUNTIME_DIR/podman/podman.sock &
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock
export HOST_CONTAINER_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock
docker compose up --build
```

### Stop and clean up

```bash
docker compose down               # stop the platform (keeps the database)
docker compose down -v            # also delete the database volume
docker rm -f $(docker ps -aq --filter label=cloud-platform.project)   # remove app containers
docker network rm cloud-platform-apps
```

Deleting projects in the dashboard first removes their containers for you.

### Hosted database (Supabase)

Set in `.env`:

```dotenv
USE_SUPABASE=yes
DATABASE_URL=postgresql://postgres.<project-ref>@aws-1-<region>.pooler.supabase.com:5432/postgres
DATABASE_PASSWORD=<your database password>
DATABASE_SSL=require
DATABASE_POOL_MAX=5
```

With `USE_SUPABASE=yes`, Compose does not start the local postgres container. Use the session pooler URL; Supabase's direct host is IPv6 only. Keep the password out of `DATABASE_URL`.

## Development

```bash
npm install
npm run typecheck
npm test              # contracts, repository rules, API routes and controller (fake drivers)
npm run format:check
```

| Path                 | What it is                                                       |
| -------------------- | ---------------------------------------------------------------- |
| `apps/web`           | Next.js dashboard                                                |
| `apps/api`           | HTTP API (`app.ts`) and deployment controller (`controller.ts`)  |
| `packages/contracts` | Request/response types, validation, deployment state machine     |
| `packages/platform`  | Config, PostgreSQL pool, migrations, project repository, logging |
| `packages/drivers`   | `Runtime`/`Router` interfaces and the local Docker/Podman driver |

Logs are JSON lines; every deployment step carries `projectId` and `deploymentId`:

```bash
docker compose logs -f api | grep <deployment id>
```

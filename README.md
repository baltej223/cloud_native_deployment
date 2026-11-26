# Cloud Deploy

A small platform-as-a-service: paste a public GitHub repository URL, and the platform clones it, uses its compose file or finds its Dockerfile, builds it, runs it and gives you a URL. Deploying a ready-made Docker image is also possible.

- Design: [cloud_platform_baseline.md](cloud_platform_baseline.md)
- Plan: [phase-wise-implementation.md](phase-wise-implementation.md)
- API: [docs/API.md](docs/API.md)

**Status:** Phases 1 and 2 are implemented, plus compose apps from Phase 3: deploy from a GitHub repository (Dockerfile or compose file) or a Docker image, locally.

## How it works

```text
Browser ── Next.js dashboard (:3000)
              │
              ▼
          Express API (:3001) ── PostgreSQL: projects + deployments (desired state)
              │
              └── Deployment controller (loop inside the API)
                    ├── Builder: git clone → find Dockerfile → read EXPOSE → docker build
                    └── Runtime: Docker Engine API socket
                          ├── cp-app-<project id>  → http://localhost:8001
                          ├── cp-app-<project id>  → http://localhost:8002
                          └── …
```

1. `POST /projects` validates the request, picks a free port (8001-8050) and stores the project with a `pending` deployment. It returns immediately. For a repository, the project name defaults to the repository name.
2. The controller checks the database every 2 seconds and takes the next step for each deployment:
   - **building** (repositories): shallow-clone the repository. If it has a compose file at the root, build or pull each of its services (see below). Otherwise find the Dockerfile (root first, then up to three folders deep, skipping `node_modules`, `.git`, `vendor` and test folders), read the port from the final stage's `EXPOSE`, and build the image with BuildKit (`docker buildx build`), so modern Dockerfile features such as `FROM --platform=$BUILDPLATFORM` and `RUN --mount` work. Output appears live in the dashboard's build log.
   - **deploying**: start a container that publishes the app on the project's port. The app also gets `PORT` set to its container port. Image sources pull the image first.
3. Once the app answers HTTP on its health check path, the deployment becomes `live`. Otherwise it becomes `failed` with a readable reason: repository not found, no Dockerfile, several Dockerfiles (listed, so you can pick one), no port, build error, crash on start, or no answer within 120 s.
4. **Redeploy** builds the latest commit again. The old version keeps serving until the new one is live; if the new one fails, the old one is started again.
5. Deleting a project removes its container and built images, then its record, which frees the name and port.

**Compose apps:** with a `compose.yaml` / `docker-compose.yml` at the root, every service runs as its own container on a network private to the project, reachable by service name; only one service gets the URL (the one that publishes a port, or the one you choose). Named volumes survive redeploys; repository folders a service mounts are copied into its image; host paths, privileged mode, host networking and similar settings are refused. Details in [docs/API.md](docs/API.md).

There is no queue: the database records what should exist, and the controller makes the container engine match it. Every step is safe to repeat, so restarting the platform resumes unfinished deployments; an interrupted build starts again.

**Isolation:** apps run on their own network (`cloud-platform-apps`), separate from the database. Each app is limited to 512 MB of memory and half a CPU, and gets no platform credentials. Builds time out after 15 minutes, and build contexts over 500 MB are refused.

## Run it locally

Requirements: Docker Engine or Docker Desktop, with Compose and buildx.

```bash
cp .env.example .env          # optional; every value has a default
docker compose up --build
```

Open http://localhost:3000, paste a repository URL, and press **Deploy**. Follow the build log on the project page; when it shows **Live**, open its URL.

Things to try (all tested):

| Repository URL                                        | Result                                     |
| ----------------------------------------------------- | ------------------------------------------ |
| `https://github.com/traefik/whoami`                   | Live; Go app, port 80 from `EXPOSE`        |
| `https://github.com/docker/welcome-to-docker`         | Live; React app, port 3000 from `EXPOSE`   |
| `https://github.com/dockersamples/example-voting-app` | Failed: two compose services publish ports |
| same, with Compose service `vote`                     | Live; all 5 services, votes reach postgres |
| same, with Dockerfile path `vote/Dockerfile`          | Live; only the vote app, from a subfolder  |
| `https://github.com/docker/getting-started-app`       | Failed: no Dockerfile                      |

On the **Docker image** tab, `nginx:alpine` with port 80 goes live without a build.

### Stop and clean up

```bash
docker compose down               # stop the platform (keeps the database)
docker compose down -v            # also delete the database volume
docker rm -f $(docker ps -aq --filter label=cloud-platform.project)   # remove app containers
docker volume rm $(docker volume ls -q --filter label=cloud-platform.project)   # compose volumes
docker network rm cloud-platform-apps $(docker network ls -q --filter label=cloud-platform.project)
```

Deleting projects in the dashboard first removes their containers and built images for you.

To remove leftover built images: `docker rmi $(docker images -q --filter reference='localhost/cp-app-*')`.

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
npm test              # contracts, Dockerfile discovery, compose parsing, API routes and controller (fake drivers)
npm run format:check

# Repository tests against a real, throwaway PostgreSQL (the database is wiped):
TEST_DATABASE_URL=postgres://app:app@localhost:5434/cloud_platform_test npm test -w @cloud-platform/platform
```

| Path                 | What it is                                                       |
| -------------------- | ---------------------------------------------------------------- |
| `apps/web`           | Next.js dashboard                                                |
| `apps/api`           | HTTP API (`app.ts`) and deployment controller (`controller.ts`)  |
| `packages/contracts` | Request/response types, validation, deployment state machine     |
| `packages/platform`  | Config, PostgreSQL pool, migrations, project repository, logging |
| `packages/drivers`   | `Runtime`/`Router` interfaces and the local Docker driver        |

Logs are JSON lines; every deployment step carries `projectId` and `deploymentId`:

```bash
docker compose logs -f api | grep <deployment id>
```

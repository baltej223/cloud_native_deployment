# API

Base URL locally: `http://localhost:3001`. Requests and responses are JSON. Errors always look like:

```json
{ "error": { "code": "INVALID_INPUT", "message": "containerPort must be between 1 and 65535." } }
```

## Projects

### `POST /projects`

Create a project and its first deployment. Returns `201` immediately; the deployment then progresses in the background.

The main way to deploy is a repository URL, and nothing else is required:

```json
{ "source": { "type": "repo", "repoUrl": "https://github.com/traefik/whoami" } }
```

Every other field is an optional override:

```json
{
  "name": "voting-vote",
  "source": {
    "type": "repo",
    "repoUrl": "https://github.com/dockersamples/example-voting-app",
    "branch": "main",
    "dockerfilePath": "vote/Dockerfile",
    "composeService": "vote"
  },
  "containerPort": 80,
  "healthCheckPath": "/",
  "env": { "GREETING": "hi" }
}
```

Or deploy a ready-made image (then `name` and `containerPort` are required):

```json
{
  "name": "hello-nginx",
  "source": { "type": "image", "image": "nginx:alpine" },
  "containerPort": 80
}
```

| Field                   | Rules                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source.repoUrl`        | Public `https://github.com/<owner>/<repo>`; `.git` and a trailing slash are accepted and removed                                                       |
| `source.branch`         | Optional; default is the repository's default branch                                                                                                   |
| `source.dockerfilePath` | Optional path inside the repository; default is found automatically (see below). Setting it skips the compose file                                     |
| `source.composeService` | Optional. For compose apps, the service that gets the URL; default is the one service that publishes a port                                            |
| `source.image`          | Docker image reference. Short names are expanded: `nginx` → `docker.io/library/nginx:latest`                                                           |
| `name`                  | 3-30 characters: lowercase letters, digits, hyphens; starts with a letter. Unique. Default for repositories: the repository name (`My_App` → `my-app`) |
| `containerPort`         | Port the app listens on, 1-65535. Default for repositories: the Dockerfile's `EXPOSE` port. A given port always wins                                   |
| `healthCheckPath`       | Optional, default `/`. The app is live once this path answers with a status below 500                                                                  |
| `env`                   | Optional. Keys like `MY_VAR`, at most 50; values up to 4096 characters. Not for secrets. `PORT` is set automatically unless you set it                 |

**Compose file:** a `compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml` at the repository root is used first (unless `dockerfilePath` is set). Every service runs: services with `build` are built, services with `image` are pulled, and they reach each other by service name on a network private to the project. One service gets the URL: the one that publishes a port (`ports:`), or `composeService`. Its container port is that `ports:` entry's container side, else its `expose:`, else its Dockerfile's `EXPOSE`. Supported per service: `image`, `build` (`context`, `dockerfile`, `args`, `target`), `command`, `entrypoint`, `environment`, `env_file`, `ports`, `expose`, `depends_on` (start order only), `restart`, `volumes`, `working_dir`, `user`; services with `profiles` are skipped. `${VAR}` references are filled from the repository's `.env` and the project's `env` (which wins); the project's `env` is not otherwise added to the services, and `PORT` is not set. Named volumes keep their data across redeploys and are deleted with the project. Repository folders a service mounts (`./src:/app`) are copied into its image instead. Refused: host paths (`/var/run/docker.sock:…`), `privileged`, `network_mode`, `cap_add`, `devices`, `pid`, `ipc`, `security_opt`, `secrets`, `configs`, `extends`, external volumes and other settings that reach into the host. At most 5 services; each gets the per-app memory and CPU limits. Other settings (`healthcheck`, `networks`, `deploy`, …) are ignored and listed in the build log.

**Dockerfile discovery:** a `Dockerfile` (or `Containerfile`) at the root wins. Otherwise the platform searches up to three folders deep, skipping hidden folders, `node_modules`, `vendor` and test folders. Exactly one match is used, with its folder as the build context. Several matches fail and list them; set `source.dockerfilePath` to pick one.

Response:

```json
{
  "project": {
    "id": "fcea9960-6a2a-4d2d-8cdd-1167ac9cf28c",
    "name": "whoami",
    "source": { "type": "repo", "repoUrl": "https://github.com/traefik/whoami" },
    "containerPort": null,
    "healthCheckPath": "/",
    "env": {},
    "url": "http://localhost:8001",
    "status": "pending",
    "latestDeployment": { "...": "same as deployment below" },
    "liveDeployment": null,
    "createdAt": "2026-11-26T13:39:40.120Z",
    "updatedAt": "2026-11-26T13:39:40.120Z"
  },
  "deployment": {
    "id": "c96b1143-9e6d-4a8c-9a37-0e4b8f2d1a55",
    "projectId": "fcea9960-6a2a-4d2d-8cdd-1167ac9cf28c",
    "status": "pending",
    "imageRef": null,
    "commitSha": null,
    "dockerfilePath": null,
    "compose": null,
    "containerPort": null,
    "failureReason": null,
    "createdAt": "2026-11-26T13:39:40.120Z",
    "startedAt": null,
    "finishedAt": null
  }
}
```

Once built, the deployment records what was used: `imageRef`, `commitSha`, `dockerfilePath` and the `containerPort` (given or detected). For compose apps, `dockerfilePath` is the compose file and `compose` is `{ "file": "docker-compose.yml", "publicService": "vote", "services": ["redis", "vote", "db", "result", "worker"] }` (start order); `imageRef` is the public service's image.

Errors: `400 INVALID_INPUT`, `409 NAME_TAKEN` (for a derived name, set `name`), `409 PROJECT_LIMIT_REACHED` (default limit 10), `409 NO_FREE_PORT`.

### `GET /projects`

`{ "projects": [ProjectView, …] }`, newest first.

### `GET /projects/:id`

One `ProjectView`. Besides the fields shown under `POST /projects`, it has `desiredState` (`running` or `stopped`), `stopReason` (`user`, `idle` or `null`) and `lastActiveAt` (last network traffic, or the last start). `latestDeployment` is the newest deployment; `liveDeployment` is the one serving the URL, which can be older (for example while a redeploy builds, or after it failed). `404 PROJECT_NOT_FOUND` for unknown IDs.

### `PATCH /projects/:id`

Change settings. Every field is optional; send only what changes. Changes apply to the next deployment (redeploy, rollback, or a restart of the live version), not to the running app.

```json
{ "env": { "GREETING": "hi" }, "containerPort": 8080, "composeService": "web" }
```

| Field                                        | Notes                                                     |
| -------------------------------------------- | --------------------------------------------------------- |
| `containerPort`                              | `null` (repositories only) goes back to detecting it      |
| `healthCheckPath`, `env`                     | Same rules as when creating; `env` replaces all variables |
| `branch`, `dockerfilePath`, `composeService` | Repositories only; `null` goes back to the default        |

The name, source type and repository URL cannot be changed (`400 INVALID_INPUT`). Returns the updated `ProjectView`.

### `POST /projects/:id/stop` and `POST /projects/:id/start`

Stop the app, or start it again. Both return `202` with the `ProjectView`; the controller stops or starts the containers within a few seconds. Stopping keeps the containers, images and volumes, and frees the app's memory and CPU; starting runs the live version again without building. A stopped project's `status` is `stopped`.

- `409 NO_LIVE_DEPLOYMENT` if the project has never gone live.
- `409 DEPLOYMENT_IN_PROGRESS` when stopping during a deployment.

Redeploying or rolling back a stopped project starts it.

**Auto-stop:** apps with no network traffic for `AUTO_STOP_IDLE_MINUTES` (default 120; 0 turns it off) are stopped with `stopReason: "idle"`. Traffic is sampled once a minute from the public container's network counters; an app that talks to its own services in the background counts as active.

**Self-healing:** if a running project's container disappears or stops (for example, removed by hand or after a server restart), the controller starts the live version again, at most every 30 seconds.

### `GET /projects/:id/logs`

The last lines the running app wrote to stdout and stderr, with timestamps.

| Query     | Notes                                               |
| --------- | --------------------------------------------------- |
| `tail`    | Lines, 1-2000; default 200                          |
| `service` | Compose apps: which service; default the public one |

```json
{
  "projectId": "…",
  "service": "vote",
  "services": ["redis", "vote", "db", "result", "worker"],
  "log": "2026-11-27T10:00:00.000000000Z  * Running on http://0.0.0.0:80\n"
}
```

`log` is empty when the app is not running. `service` is `null` for single-container apps.

### `DELETE /projects/:id`

Returns `202 { "id": "…", "status": "deleting" }`. The controller stops any build, removes the app and its built images, then the project record; after that, `GET /projects/:id` returns `404` and the name and port can be reused.

## Login

When the API has `ADMIN_PASSWORD` set, every endpoint except `/health/*`,
`GET /auth/session` and `POST /auth/login` needs a session cookie, and answers
`401 UNAUTHORIZED` without one.

- `POST /auth/login` `{ "password": "..." }`: sets `cp_session` (HttpOnly,
  SameSite=Strict, Secure with `SECURE_COOKIES=true`, 12 hours). Wrong password:
  `401`; five failures from one address in 15 minutes: `429 TOO_MANY_ATTEMPTS`.
- `POST /auth/logout`: clears the cookie.
- `GET /auth/session`: `{ "required": true, "signedIn": false }`.

Without `ADMIN_PASSWORD` (local development) login is off and `required` is `false`.

## Deployments

### `POST /projects/:id/deployments`

Redeploy: build the latest commit of the branch again (or pull the image again). Returns `202` with the new `DeploymentView`. The current version keeps serving until the new one is live; if the new one fails, the previous version is started again.

`409 DEPLOYMENT_IN_PROGRESS` while another deployment of the project is pending, building or deploying.

### `POST /projects/:id/rollback`

Deploy an earlier version again from its image, without building: `{ "deploymentId": "…" }`. Only deployments that were live (`superseded`) can be chosen. The new deployment has `rollbackOf` set and goes `pending → deploying → live`. It uses the earlier version's image, commit, port and compose services, with the project's current environment variables and health check. Returns `202` with the new `DeploymentView`.

`404 DEPLOYMENT_NOT_FOUND`, `409 ROLLBACK_NOT_POSSIBLE` (already live, or never live), `409 DEPLOYMENT_IN_PROGRESS`.

### `GET /projects/:id/deployments`

`{ "deployments": [DeploymentView, …] }`, newest first (last 20).

### `GET /deployments/:id`

One `DeploymentView`. `404 DEPLOYMENT_NOT_FOUND` for unknown IDs.

### `GET /deployments/:id/logs`

The build log, updated about once a second while the build runs:

```json
{
  "deploymentId": "c96b1143-9e6d-4a8c-9a37-0e4b8f2d1a55",
  "status": "live",
  "log": "==> Cloning https://github.com/traefik/whoami\n==> Commit 1ce75d0…\n==> Using Dockerfile (found automatically), build context the repository root\n==> Dockerfile exposes port 80\n…",
  "truncated": false
}
```

Only the last 256 KB are kept (`truncated` is then `true`). Image deployments have no build log.

## Statuses

A project's `status` is its latest deployment's status, `stopped` (stopped and nothing in progress) or `deleting`.

```text
pending ──► building ──► deploying ──► live ──► superseded   (when a newer deployment goes live)
   │  (repos)   │             │
   │            ▼             ▼
   └────────► failed ◄────────┘      (failureReason says why)

pending ──► deploying                (image sources and rollbacks skip the build)
```

`cancelled` is reserved for later use. Deployments never move backwards; the database rejects invalid transitions.

Typical failure reasons:

- `Repository https://github.com/a/b was not found, or it is private.`
- `Branch dev does not exist in https://github.com/a/b.`
- `No Dockerfile found in https://github.com/a/b (looked in the root and up to 3 folders deep). Add a Dockerfile to the repository.`
- `Several services in docker-compose.yml publish ports: vote, result. Choose the one that gets the URL with the Compose service setting and deploy again.`
- `compose.yaml, service app mounts /var/run/docker.sock from the host, which the platform does not allow. Use a named volume.`
- `Found several Dockerfiles: api/Dockerfile, web/Dockerfile. Choose one with the Dockerfile path setting and deploy again.`
- `Dockerfile has no EXPOSE instruction, so the port the app listens on is unknown. Set the container port and deploy again.`
- `The build failed: … See the build log for details.`
- `The build did not finish within 15 min.`
- `Image docker.io/x/y:1 was not found, or it is private.`
- `The app exited with code 1 right after starting. Check that the image runs on its own.`
- `The app did not answer on port 9999 at / within 120 s. Check the container port.`
- `Port 8003 on the host is already in use by another program.`

## Health

- `GET /health/live`: `200 {"status":"ok"}` while the process runs.
  **Several API instances:** only the instance holding a PostgreSQL advisory lock runs the deployment controller; the others serve HTTP and take over within one tick if it stops. With Supabase, use the session pooler (port 5432); the transaction pooler does not keep advisory locks.

- `GET /health/ready`: `200` when the database and the container engine are reachable, otherwise `503` with `checks` naming the failing dependency.

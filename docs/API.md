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
    "dockerfilePath": "vote/Dockerfile"
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
| `source.dockerfilePath` | Optional path inside the repository; default is found automatically (see below)                                                                        |
| `source.image`          | Docker image reference. Short names are expanded: `nginx` → `docker.io/library/nginx:latest`                                                           |
| `name`                  | 3-30 characters: lowercase letters, digits, hyphens; starts with a letter. Unique. Default for repositories: the repository name (`My_App` → `my-app`) |
| `containerPort`         | Port the app listens on, 1-65535. Default for repositories: the Dockerfile's `EXPOSE` port. A given port always wins                                   |
| `healthCheckPath`       | Optional, default `/`. The app is live once this path answers with a status below 500                                                                  |
| `env`                   | Optional. Keys like `MY_VAR`, at most 50; values up to 4096 characters. Not for secrets. `PORT` is set automatically unless you set it                 |

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
    "containerPort": null,
    "failureReason": null,
    "createdAt": "2026-11-26T13:39:40.120Z",
    "startedAt": null,
    "finishedAt": null
  }
}
```

Once built, the deployment records what was used: `imageRef`, `commitSha`, `dockerfilePath` and the `containerPort` (given or detected).

Errors: `400 INVALID_INPUT`, `409 NAME_TAKEN` (for a derived name, set `name`), `409 PROJECT_LIMIT_REACHED` (default limit 10), `409 NO_FREE_PORT`.

### `GET /projects`

`{ "projects": [ProjectView, …] }`, newest first.

### `GET /projects/:id`

One `ProjectView`. `latestDeployment` is the newest deployment; `liveDeployment` is the one serving the URL, which can be older (for example while a redeploy builds, or after it failed). `404 PROJECT_NOT_FOUND` for unknown IDs.

### `DELETE /projects/:id`

Returns `202 { "id": "…", "status": "deleting" }`. The controller stops any build, removes the app and its built images, then the project record; after that, `GET /projects/:id` returns `404` and the name and port can be reused.

## Deployments

### `POST /projects/:id/deployments`

Redeploy: build the latest commit of the branch again (or pull the image again). Returns `202` with the new `DeploymentView`. The current version keeps serving until the new one is live; if the new one fails, the previous version is started again.

`409 DEPLOYMENT_IN_PROGRESS` while another deployment of the project is pending, building or deploying.

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

A project's `status` is its latest deployment's status, or `deleting`.

```text
pending ──► building ──► deploying ──► live ──► superseded   (when a newer deployment goes live)
   │  (repos)   │             │
   │            ▼             ▼
   └────────► failed ◄────────┘      (failureReason says why)

pending ──► deploying                (image sources skip the build)
```

`cancelled` is reserved for later phases. Deployments never move backwards; the database rejects invalid transitions.

Typical failure reasons:

- `Repository https://github.com/a/b was not found, or it is private.`
- `Branch dev does not exist in https://github.com/a/b.`
- `No Dockerfile found in https://github.com/a/b (looked in the root and up to 3 folders deep). Add a Dockerfile to the repository.`
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
- `GET /health/ready`: `200` when the database and the container engine are reachable, otherwise `503` with `checks` naming the failing dependency.

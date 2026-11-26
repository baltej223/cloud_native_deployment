# API

Base URL locally: `http://localhost:3001`. Requests and responses are JSON. Errors always look like:

```json
{ "error": { "code": "INVALID_INPUT", "message": "containerPort must be between 1 and 65535." } }
```

## Projects

### `POST /projects`

Create a project and its first deployment. Returns `201` immediately; the deployment then progresses in the background.

```json
{
  "name": "hello-nginx",
  "source": { "type": "image", "image": "nginx:alpine" },
  "containerPort": 80,
  "healthCheckPath": "/",
  "env": { "GREETING": "hi" }
}
```

| Field             | Rules                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `name`            | 3-30 characters: lowercase letters, digits, hyphens; starts with a letter. Unique.           |
| `source.type`     | `"image"` (repositories arrive in Phase 2)                                                   |
| `source.image`    | Docker image reference. Short names are expanded: `nginx` → `docker.io/library/nginx:latest` |
| `containerPort`   | Port the app listens on inside the container, 1-65535                                        |
| `healthCheckPath` | Optional, default `/`. The app is live once this path answers with a status below 500        |
| `env`             | Optional. Keys like `MY_VAR`, at most 50; values up to 4096 characters. Not for secrets      |

Response:

```json
{
  "project": {
    "id": "04519676-71fc-45e1-83ef-f31a01fa8ec6",
    "name": "hello-nginx",
    "source": { "type": "image", "image": "docker.io/library/nginx:alpine" },
    "containerPort": 80,
    "healthCheckPath": "/",
    "env": { "GREETING": "hi" },
    "url": "http://localhost:8001",
    "status": "pending",
    "latestDeployment": { "...": "same as deployment below" },
    "createdAt": "2026-11-26T10:13:50.120Z",
    "updatedAt": "2026-11-26T10:13:50.120Z"
  },
  "deployment": {
    "id": "464f1de4-b1a1-47ba-8136-ea152cb30126",
    "projectId": "04519676-71fc-45e1-83ef-f31a01fa8ec6",
    "status": "pending",
    "imageRef": null,
    "failureReason": null,
    "createdAt": "2026-11-26T10:13:50.120Z",
    "startedAt": null,
    "finishedAt": null
  }
}
```

Errors: `400 INVALID_INPUT`, `409 NAME_TAKEN`, `409 PROJECT_LIMIT_REACHED` (default limit 10), `409 NO_FREE_PORT`.

### `GET /projects`

`{ "projects": [ProjectView, …] }`, newest first.

### `GET /projects/:id`

One `ProjectView`. `404 PROJECT_NOT_FOUND` for unknown IDs.

### `DELETE /projects/:id`

Returns `202 { "id": "…", "status": "deleting" }`. The controller removes the app, then the project record; after that, `GET /projects/:id` returns `404` and the name and port can be reused.

## Statuses

A project's `status` is its latest deployment's status, or `deleting`.

```text
pending ──► deploying ──► live ──► superseded   (when a newer deployment goes live)
   │            │
   └────────────┴──► failed     (failureReason says why)
```

`building` (repository sources) and `cancelled` are reserved for later phases. Deployments never move backwards; the database rejects invalid transitions.

Typical failure reasons:

- `Image docker.io/x/y:1 was not found, or it is private.`
- `The app exited with code 1 right after starting. Check that the image runs on its own.`
- `The app did not answer on port 9999 at / within 120 s. Check the container port.`
- `Port 8003 on the host is already in use by another program.`

## Health

- `GET /health/live`: `200 {"status":"ok"}` while the process runs.
- `GET /health/ready`: `200` when the database and the container engine are reachable, otherwise `503` with `checks` naming the failing dependency.

# Cloud Platform: Phase-Wise Implementation Plan

This plan turns the deployment platform described in [cloud_platform_baseline.md](cloud_platform_baseline.md) into six deliverable phases. Each phase builds on the previous one, so the platform works locally before AWS infrastructure and automated deployment are introduced.

## Architecture at a glance

```text
Browser
  └── Next.js dashboard
        └── Node.js API ─────────── PostgreSQL (projects, deployments: desired state)
              └── Deployment controller (reconciliation loop inside the API)
                    ├── Builder  : clone repo + docker build + push   (local: Docker/Podman, AWS: CodeBuild → ECR)
                    ├── Runtime  : run the app container              (local: Docker/Podman, AWS: ECS Fargate service)
                    └── Router   : give the app a URL                 (local: host port,     AWS: ALB listener port or host rule)

Platform on AWS: ECS (web, api), ECR, ALB, CodeBuild, CloudWatch, IAM, SSM Parameter Store, CloudFormation
Platform CI/CD:  GitHub Actions → ECR → ECS
Local development: Docker Compose, PostgreSQL, Docker/Podman socket for running user apps
```

There is no message queue. PostgreSQL records what should exist, and the deployment controller makes the real infrastructure match it. The three drivers (Builder, Runtime, Router) are interfaces with a local implementation and an AWS implementation, so the same controller works on a laptop and on AWS.

## Starting point

The repository currently implements an earlier design: an asynchronous image-processing job runner (API, SQS, worker, S3). The following parts carry over to this plan unchanged or with small changes:

- The monorepo layout, TypeScript setup, Next.js web app, Express API, PostgreSQL migrations, configuration parsing, structured logging and the Supabase support.
- The CloudFormation stack: VPC, ECS cluster, ECR, ALB, log groups, IAM roles, SSM parameter for the database password, alarms and dashboard.
- The GitHub Actions pipeline with OIDC, versioned images, the migration task and the rollout.

The SQS queue, dead-letter queue, worker service, S3 file bucket and image processor are removed in Phase 1. The CloudFormation resources for them are removed in Phase 4.

---

## Phase 1: Deploy a Docker image locally

### Goal

Build the first working slice on a developer machine, without an AWS account. A user enters a Docker image and a port in the dashboard, and the platform runs it and shows a working URL.

### Work

- Replace the job model with `projects` and `deployments` (see Phase 2 for the full fields; Phase 1 needs only the image source).
- Define the `Runtime` and `Router` interfaces and implement the local versions with the Docker Engine API over the Docker/Podman socket.
- Implement the first version of the deployment controller: pull the image, start the container with a host port from a fixed range (8001-8050), wait until the port responds, mark the deployment `live`.
- Build the dashboard: a "New project" form (name, image, port, environment variables), a project list with status and URL, and a project page that polls status.
- Remove the queue, worker, S3 and image-processing code and their Compose services.

### Deliverable

`docker compose up` starts the platform. Deploying `nginx:alpine` on port 80 from the dashboard shows `live` and a URL such as `http://localhost:8001` that serves the nginx page.

### Completion checks

- A valid image deploys and its URL works; an image that does not exist fails with a clear reason.
- The platform restarts without losing projects or their ports.
- Deleting a project stops and removes its container and frees its port.

See [Phase 1: Build the platform locally](phase-1-application-building.md) for the detailed local build guide.

---

## Phase 2: Deploy from a GitHub repository and define the lifecycle

### Goal

Make **a GitHub repository the main way to deploy**: the user pastes a URL, and the platform finds the Dockerfile, builds it and runs it. Also make the deployment lifecycle and API contract explicit and durable.

### Data model

`projects`:

- `id` (UUID), `name` (unique, lowercase DNS label, 3-30 characters)
- `source_type`: `image` or `repo`
- `image` (for image sources); `repo_url`, `branch` (default: the repository's default branch), optional `dockerfile_path` override for repository sources
- `container_port` (optional for repositories: detected from `EXPOSE`), `health_check_path` (default `/`), `env` (JSONB)
- `assigned_port` (unique; local host port or ALB listener port), `desired_state`: `running` or `stopped`
- `created_at`, `updated_at`, `last_activity_at`

`deployments`:

- `id` (UUID), `project_id`, `status`, `image_ref` (set once built or resolved)
- `dockerfile_path` and `context_path` actually used (as discovered), `commit_sha`
- `build_id`, `failure_reason` (safe summary), `created_at`, `updated_at`, `started_at`, `finished_at`

Deployment states: `pending` → `building` (repository only) → `deploying` → `live`, or `failed` from any non-final state; a live deployment becomes `superseded` when a newer one goes live, and `cancelled` if the project is deleted first. A database trigger rejects any other transition.

### API contract

- `POST /projects`: validate and create a project and its first deployment; return `201` with both. Reject duplicate names (`409`) and requests over the project limit.
- `GET /projects`, `GET /projects/:id`: current state, URL and latest deployment.
- `POST /projects/:id/deployments`: redeploy (build again or pull again).
- `GET /projects/:id/deployments`, `GET /deployments/:id`: history and status.
- `GET /deployments/:id/logs`: build logs. `GET /projects/:id/logs`: runtime logs.
- `PATCH /projects/:id`: change env vars, port or health check path (takes effect on the next deployment).
- `DELETE /projects/:id`: tear the app down.
- Health endpoints: `GET /health/live`, `GET /health/ready`.

### Work

- Make the repository form the default in the dashboard: a single "GitHub repository" field, with branch, Dockerfile path, port and env vars under "Advanced". The image form moves to a secondary tab.
- Implement the local `Builder`: clone the repository at the branch (shallow) into a temporary directory, record the commit, **discover the Dockerfile** (root first, then up to three levels deep, skipping `node_modules`, `.git`, `vendor` and test folders; a single match wins, several matches fail with the list of candidates), **detect the port** from the final stage's `EXPOSE`, build with the discovered Dockerfile and its directory as context, tag the image with the deployment ID, and save the build output as logs.
- Pass the port to the app as `PORT`, so apps that read it listen where the platform expects.
- Validate repository URLs (public `https://github.com/<owner>/<repo>` only) and image references.

### Deliverable

A documented API and migrations. Pasting only the URL of a public repository with a Dockerfile, for example a small Node.js or Python web app, produces a live URL locally, with no other input.

### Completion checks

- Invalid input returns `400` with field errors and creates nothing.
- A repository whose Dockerfile sits in a subfolder deploys without the user naming it.
- A repository with several candidate Dockerfiles fails with the list; choosing one deploys it.
- A repository without a Dockerfile, or with a failing build, ends `failed` with the build log available.
- Status can be read at every stage.
- API errors never expose stack traces, credentials or internal hostnames.

---

## Phase 3: Make the controller reliable and add app management

### Goal

Make the deployment controller safe to restart and run in parallel, and add the day-to-day operations users need.

### Work

- Run the controller as a reconciliation loop: each tick reads unfinished deployments and projects whose desired state differs from the actual state, and moves each one forward one step.
- Make each step idempotent: name every resource after the project ID and check before creating. A crash between steps must not create duplicates or lose a deployment.
- Use a PostgreSQL advisory lock so only one API instance runs the controller.
- Add timeouts: build (15 minutes), health check (5 minutes). Mark the deployment `failed` with the reason when a timeout is hit.
- Keep the previous live version serving until the new one is healthy; on failure, the old version stays live.
- Add redeploy, roll back (redeploy an earlier image without rebuilding), stop, start and delete.
- Add runtime logs and auto-stop after the idle period (default 2 hours, configurable).

### Deliverable

A controller with a documented state machine, and a dashboard that supports the full app lifecycle.

### Completion checks

- Killing the API during a build or rollout does not lose the deployment; it resumes after restart.
- Running two API instances does not double any step.
- A broken new version does not take down the live one.
- Stopped and deleted apps release their resources.

---

## Phase 4: Add AWS drivers and deploy the platform to AWS

### Goal

Run the same platform on AWS, with user apps built by CodeBuild and run on ECS.

### Resources

- **AWS CodeBuild:** one project that clones a repository, builds the image and pushes it to ECR. Parameters (repository, branch, Dockerfile, image tag) are passed per build. Privileged mode for Docker builds; 15-minute timeout; logs to CloudWatch.
- **Amazon ECR:** repositories for the platform images (web, api, migrate) and one `apps` repository for user images, with a lifecycle policy that keeps the latest images only.
- **Amazon ECS on Fargate:** the platform's web and API services, plus one service per user app, created by the controller.
- **Application Load Balancer:** port 80 serves the platform. Each user app gets its own listener on its assigned port (8001-8050) and its own target group. An optional domain mode uses host-based rules on one listener instead.
- **VPC and security groups:** the ALB security group allows the platform port from the allowed IP range and the app ports from anywhere; app tasks only accept traffic from the ALB.
- **IAM:** a task role for the API scoped to platform-prefixed ECS services, task definitions, listeners, target groups and the one CodeBuild project; `iam:PassRole` only for the app execution role; a CodeBuild role that can push only to the `apps` repository; an app execution role that can only pull from ECR and write logs.
- **SSM Parameter Store:** the database password, injected into the API at runtime.
- **CloudWatch Logs:** separate log groups for the platform, builds and apps.

Implement `Builder` with CodeBuild, `Runtime` with ECS, and `Router` with ALB listeners and target groups. Select the drivers with configuration (`PLATFORM_DRIVER=local` or `aws`).

### Deliverable

A staging environment where a user can deploy an image or repository from the dashboard and open the app through its ALB URL.

### Completion checks

- The platform is reachable through the ALB and its health checks pass.
- Deploying an image and a repository on AWS each produce a working URL.
- User apps have no IAM task role and cannot reach AWS APIs with platform credentials.
- Deleting a project removes its ECS service, task definitions, listener and target group.

---

## Phase 5: Infrastructure as code and CI/CD for the platform

### Goal

Make the environment reproducible and deploy platform changes through a controlled pipeline.

### Work

- Define all platform resources in CloudFormation: networking, security groups, ECR repositories, ECS cluster and services, ALB, CodeBuild project, log groups, IAM roles, SSM references, alarms and dashboard. Per-app resources are created by the controller at runtime, not by the stack; tag them so they can be found and cleaned up.
- Keep environment-specific values as parameters: region, allowed IP range, port range, project limit, task sizes, idle timeout, optional domain.
- Use GitHub Actions to run checks, build and push versioned images, run migrations as a one-off ECS task and update the stack.
- Authenticate GitHub Actions to AWS through OIDC with narrowly scoped roles; no stored AWS keys.
- Keep build and deploy permissions separate from the permissions of running tasks.
- Provide a teardown script that deletes all per-app resources before deleting the stack.

### Deliverable

Infrastructure code and a GitHub Actions workflow that deploy a reviewed change to staging from the repository, and a documented, complete teardown.

### Completion checks

- A clean account can be brought up from the templates and docs alone.
- A push to `main` runs checks, pushes images and rolls out the new version.
- Deployments use versioned images and can be rolled back.
- Teardown leaves no billable resources, including user apps.
- Secrets do not appear in the repository, images or workflow logs.

---

## Phase 6: Security hardening, limits and monitoring

### Goal

Make the platform safe to leave running for a demo, and observable when something goes wrong.

### Security and limits

- Require a deploy token for all write endpoints.
- Enforce the project limit, fixed task sizes and build timeouts.
- Stop idle apps automatically and record why.
- Reject private network targets and non-GitHub sources.
- Add a cleanup job that finds tagged per-app resources with no matching project and removes them.

### Monitoring

- Send platform, build and app logs to CloudWatch Logs with structured fields (project, deployment, step).
- Publish metrics: deployments started, succeeded and failed; build duration; time to live; running apps.
- Build a CloudWatch dashboard with these metrics, per-app ALB request and 5xx counts, platform CPU and memory, and alarm states.
- Add alarms for repeated deployment failures, unhealthy platform targets, platform 5xx errors and running app tasks above the expected maximum.

### Deliverable

A staging deployment with enforced limits, auto-stop, a dashboard and alarms.

### Completion checks

- Requests without the deploy token are rejected.
- An idle app stops by itself, and its URL works again after a start.
- A failed deployment is visible on the dashboard and raises an alarm when failures repeat.
- Operators can trace a deployment from submission to live using its ID in the logs.

---

## Cross-phase engineering practices

- PostgreSQL is the source of truth for desired state; infrastructure is brought in line with it, never the other way round.
- Every controller step is idempotent and safe to retry.
- Keep cloud-specific code behind the Builder, Runtime and Router interfaces.
- Validate all external input: names, repository URLs, image references, ports, env var keys.
- Never give user apps platform credentials or AWS permissions.
- Use structured logs and include the project and deployment IDs wherever available.
- Add automated tests as each phase is implemented, prioritizing the state machine, controller steps (with fake drivers) and the API contract.

## AWS references

- [ECS task IAM roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html)
- [ECS rolling update deployments](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html)
- [CodeBuild Docker builds](https://docs.aws.amazon.com/codebuild/latest/userguide/sample-docker.html)
- [ALB listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html)
- [ALB quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html)

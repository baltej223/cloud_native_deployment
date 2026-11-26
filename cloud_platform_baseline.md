# Cloud-Native Deployment Platform

## 1. The Problem: What are we trying to solve?

Putting an application on the internet is still harder than writing it. A developer who has a working app in a GitHub repository, or a Docker image, faces a long list of chores before anyone else can use it:

1. **Manual, error-prone deployment:** Building the image, pushing it to a registry, writing container definitions, opening ports, wiring a load balancer and checking health are all done by hand. Each step is a chance to make a mistake, and nobody wants to repeat it for every change.

2. **Infrastructure knowledge as a barrier:** To deploy on a cloud provider, a developer has to understand networking, IAM, container orchestration and load balancing. Most developers only want a URL that serves their app.

3. **No standard way to observe or update a running app:** Without a platform, every app ends up with its own way to view logs, redeploy, roll back or shut down. Mistakes are slow to notice and expensive to fix, and forgotten apps keep costing money.

Hosted platforms such as Vercel, Render and Heroku solve this by hiding the infrastructure behind "give us your code, get a URL". This project builds a small platform of that kind on AWS, to show how such a system works inside.

## 2. Our Solution: What is our approach?

We are building a mini Platform-as-a-Service (PaaS) on AWS. A user gives the platform **a public GitHub repository URL**. The platform clones it, **finds the Dockerfile itself**, builds the image, runs it as a container, routes traffic to it and returns a **public URL**. Deploying a ready-made Docker image is also possible, as a secondary, advanced option. The platform itself is also deployed automatically from its own repository.

**Key Pillars of the Solution:**

* **One-step deployment for users:** Paste a repository URL. The platform finds the Dockerfile, works out the port, and handles cloning, building, pushing, running, routing and health checking, reporting progress until the app is live. Users never have to describe their container by hand.

* **The platform deploys itself (CI/CD):** Every push to the platform's own repository runs checks, builds images and rolls out the new version, with no manual steps.

* **Isolation and least privilege:** Every user app runs in its own container with fixed CPU and memory limits and no AWS permissions. The platform's own components only get the permissions they need.

* **Self-healing and observable:** The platform records the desired state of every app in its database and keeps the real infrastructure in line with it. Each app has its own build logs, runtime logs and health status, and the platform reports its overall health through CloudWatch.

* **Cost-aware by design:** Apps have resource limits, there is a limit on the number of apps, and idle apps stop automatically, so a demo does not turn into a bill.

## 3. Implementation Plan: How will it be built?

The implementation uses AWS managed services, Docker, Next.js and Node.js.

### A. Tech Stack

* **Frontend:** Next.js (platform dashboard)

* **Backend API:** Node.js (Express), including the deployment controller

* **Containerization:** Docker

* **CI/CD (platform itself):** GitHub Actions

* **Builds (user apps):** AWS CodeBuild

* **AWS Services:** Amazon ECS on Fargate, Amazon ECR, AWS CodeBuild, Application Load Balancer (ALB), Amazon CloudWatch, AWS IAM, AWS Systems Manager Parameter Store, AWS CloudFormation

* **Database:** PostgreSQL (hosted on Supabase; Amazon RDS also works with only a configuration change)

### B. Architectural Workflow

**Part 1: Deploying a user's app**

1. **Submit:** The user opens the platform dashboard and pastes a public GitHub repository URL. Branch, Dockerfile path, port and environment variables are optional overrides. (Advanced: a Docker image reference instead of a repository.)

   **Dockerfile discovery:** the platform clones the repository (shallow) and looks for a `Dockerfile` (or `Containerfile`) at the root. If there is none, it searches subdirectories up to three levels deep, skipping folders such as `node_modules`, `.git`, `vendor` and test fixtures. Exactly one match is used, with its directory as the build context. If several match, the root one wins; otherwise the deployment fails and lists the candidates so the user can pick one. A repository with no Dockerfile fails with a clear message.

   **Port detection:** a port the user gives always wins. Otherwise the platform reads the `EXPOSE` instruction of the Dockerfile's final stage; if there is none, the deployment fails asking for a port. The chosen port is also passed to the app as the `PORT` environment variable, which many frameworks read.

2. **Record the deployment:** The API validates the request, saves the project and a new deployment in PostgreSQL with status `pending`, and responds right away. PostgreSQL holds the desired state; it is the source of truth.

3. **Build (repository source only):** The deployment controller starts an **AWS CodeBuild** build. CodeBuild clones the repository, runs `docker build` and pushes the image to **Amazon ECR**. Status: `building`. Image sources skip this step.

4. **Run:** The controller registers an **ECS task definition** for the image, with fixed CPU and memory and no task role. It then creates or updates the project's **ECS service** on Fargate. Status: `deploying`.

5. **Route:** The controller attaches the service to the **Application Load Balancer**. Each project gets its own ALB listener port, and its URL is `http://<load-balancer>:<port>`. If a domain is configured, each project instead gets `<project>.<domain>` through host-based routing.

6. **Go live:** When the ALB health check passes, the deployment becomes `live` and the dashboard shows the URL. If the build fails, the container keeps crashing or the health check never passes, the deployment becomes `failed` with a clear reason, and the previous live version, if there is one, keeps serving.

**Part 2: The deployment controller (no queue)**

Builds and rollouts take minutes, so the API does not do them inside the HTTP request. Instead a **reconciliation loop** runs inside the API service:

1. It periodically reads deployments that are not finished from PostgreSQL.
2. For each one, it checks the real state in AWS (build status, service status, target health) and takes the next step.
3. Every step is idempotent: resources are named after the project, and the controller checks before it creates. A crash or restart simply resumes from the state in the database.
4. A PostgreSQL advisory lock ensures that only one API task runs the controller at a time, even when the API scales out.

This replaces a message queue: the database records what should exist, and the controller makes AWS match it.

**Part 3: Managing a running app**

* **Redeploy:** Build or pull again and roll out the new version (ECS rolling update; the old version serves until the new one is healthy).
* **Roll back:** Redeploy an earlier deployment's image, with no rebuild.
* **Stop / start:** Scale the service to 0 or back to 1, keeping the URL.
* **Delete:** Remove the service, listener and target group; release the port.
* **Logs:** Build logs (from CodeBuild) and runtime logs (from the container) are shown in the dashboard, read from CloudWatch Logs.
* **Auto-stop:** Apps stop after a configurable idle period (default 2 hours) to limit cost.

**Part 4: CI/CD for the platform itself**

1. **Source Control & CI:** A developer pushes code to the platform's GitHub repository.
2. **Build & Package:** GitHub Actions runs type checks, tests and formatting checks, then builds the web and API images.
3. **Registry:** The pipeline pushes the images, tagged with the commit, to **Amazon ECR**.
4. **Deployment:** The pipeline runs database migrations as a one-off ECS task, then updates the CloudFormation stack, so **Amazon ECS** rolls out the new images with a circuit breaker that rolls back on failure.
5. **Traffic Routing:** The **ALB** routes the platform's own traffic (port 80) to the web and API services.

GitHub Actions authenticates to AWS through OIDC with a short-lived role; there are no stored AWS keys.

### C. Security, Reliability and Observability

* **Isolation of user apps:** Each app runs in its own Fargate task with 0.25 vCPU and 512 MB by default, no IAM task role, and a security group that only accepts traffic from the ALB. User apps cannot reach the platform's database credentials or AWS APIs.

* **Least privilege (IAM):** The API's task role can only manage resources whose names start with the platform's prefix, can pass only the app execution role, and can start only the platform's CodeBuild project. The CodeBuild role can push only to the apps ECR repository. GitHub Actions has a separate deploy role.

* **Access control:** The platform dashboard and API are only reachable from an allowed IP range, and creating deployments requires a deploy token. Deployed apps are public, because the point is to share the URL.

* **Limits:** There is a maximum number of projects (default 10), fixed task sizes, a build timeout (15 minutes), and the idle auto-stop.

* **Reliability:** ECS restarts crashed containers, rolling updates keep the old version until the new one is healthy, and the controller resumes cleanly after restarts.

* **Monitoring:** **Amazon CloudWatch** collects platform and app logs. A dashboard shows running apps, deployments per hour, build duration, failed deployments, per-app request and error counts from the ALB, and platform CPU. Alarms fire on repeated deployment failures, unhealthy platform targets, platform 5xx errors and an unexpectedly high number of running app tasks (a cost guard).

* **Secrets:** The database password is stored in SSM Parameter Store and injected into the API at runtime; it is never in the repository, images or logs. App environment variables are stored in the platform database and are not meant for secrets in the first version.

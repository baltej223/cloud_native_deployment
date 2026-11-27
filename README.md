# Cloud Deploy

A small platform-as-a-service: paste a public GitHub repository URL, and the platform clones it, uses its compose file or finds its Dockerfile, builds it, runs it and gives you a URL. Deploying a ready-made Docker image is also possible.

- Design: [cloud_platform_baseline.md](cloud_platform_baseline.md)
- Plan: [phase-wise-implementation.md](phase-wise-implementation.md)
- API: [docs/API.md](docs/API.md)

**Status:** Phases 1-3 are implemented, locally: deploy from a GitHub repository (Dockerfile or compose file) or a Docker image, then redeploy, roll back, stop, start, edit settings and read the app's logs. Idle apps stop automatically.

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
4. **Redeploy** builds the latest commit again. The old version keeps serving until the new one is live; if the new one fails, the old one is started again. **Roll back** deploys an earlier version's image without building.
5. **Stop** and **Start** stop and start the app's containers (data is kept). Apps with no traffic for 2 hours stop automatically (`AUTO_STOP_IDLE_MINUTES`); a running app whose container disappears is started again.
6. **Edit settings** (variables, port, health check, branch, Dockerfile, compose service) applies to the next deployment. The project page also shows the app's own logs.
7. Deleting a project removes its containers, volumes and built images, then its record, which frees the name and port.

**Compose apps:** with a `compose.yaml` / `docker-compose.yml` at the root, every service runs as its own container on a network private to the project, reachable by service name; only one service gets the URL (the one that publishes a port, or the one you choose). Named volumes survive redeploys; repository folders a service mounts are copied into its image; host paths, privileged mode, host networking and similar settings are refused. Details in [docs/API.md](docs/API.md).

There is no queue: the database records what should exist, and the controller makes the container engine match it. Every step is safe to repeat, so restarting the platform resumes unfinished deployments; an interrupted build starts again. When several API instances run, a PostgreSQL advisory lock lets only one of them run the controller.

**Isolation:** apps run on their own network (`cloud-platform-apps`), separate from the database. Each app is limited to 512 MB of memory and half a CPU, and gets no platform credentials. Builds time out after 15 minutes, and build contexts over 500 MB are refused.

## Run it locally

Requirements: Docker Engine or Docker Desktop, with Compose and buildx.

### Start and stop

```bash
cp .env.example .env              # once; optional, every value has a default

docker compose up -d --build      # start (or update after code changes) in the background
docker compose ps                 # check: api and postgres "healthy", web "Up"
docker compose logs -f api        # follow the API and controller logs (Ctrl+C to leave)

docker compose stop               # stop the platform; start again with: docker compose start
docker compose down               # stop and remove the platform's containers (keeps the database)
```

`.env` with `USE_SUPABASE=yes` uses the hosted database. To start with the local one regardless:

```bash
USE_SUPABASE= DATABASE_URL= DATABASE_PASSWORD= DATABASE_SSL=disable docker compose up -d --build
```

Stopping the platform does not stop deployed apps: they are separate containers. Delete projects in the dashboard first, or remove them as shown under [Clean up](#clean-up).

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

### Clean up

```bash
docker compose down -v            # stop the platform and delete its database volume
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

## Run it on AWS (one EC2 instance)

`deploy/aws/platform.yaml` is a CloudFormation stack sized for the free tier: one
Ubuntu instance (t3.micro, 20 GiB gp3, 2 GiB swap) with an Elastic IP, running
Docker, this Compose stack and Caddy. The dashboard is at `https://<your domain>`
behind a password. Apps get `https://<project>.<your domain>`, and every other
compose service that publishes ports gets `https://<service>.<project>.<your domain>`.
There is no SSH;
use Session Manager.

1. Store the admin password (type it yourself; it never goes in the repository):

   ```bash
   read -rs PW && aws ssm put-parameter --name /cloud-platform/admin-password \
     --type SecureString --overwrite --value "$PW"; unset PW
   ```

2. Create or update the stack, then point two DNS **A records** at the `ElasticIp`
   output: your domain, and the wildcard `*.<your domain>` for the apps. Caddy gets
   each certificate when a name is first visited (only for names of deployed apps).

   ```bash
   aws cloudformation deploy --stack-name cloud-platform \
     --template-file deploy/aws/platform.yaml --capabilities CAPABILITY_IAM \
     --parameter-overrides Domain=deploy.example.com
   aws cloudformation describe-stacks --stack-name cloud-platform \
     --query "Stacks[0].Outputs" --output table
   ```

The first boot installs Docker and builds the images (5-20 minutes; log:
`/var/log/cloud-platform-setup.log`). On every boot `deploy/aws/start.sh` reads the
domain and password from SSM Parameter Store and starts the platform. To change
the password, update the parameter and run
`sudo systemctl restart cloud-platform` on the instance. On the instance, apps are
limited to 256 MB, 5 projects and 30 minutes idle time.

Locally, login is off unless `ADMIN_PASSWORD` is set.

### Pause and resume (save money)

Stopping the instance keeps everything (projects, database, certificate, the Elastic
IP and DNS). While stopped you pay only for the 20 GiB disk and the idle Elastic IP,
roughly US$5 a month at list prices, less within the free tier.

```bash
ID=$(aws cloudformation describe-stacks --stack-name cloud-platform \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)

aws ec2 stop-instances --instance-ids "$ID"     # pause
aws ec2 start-instances --instance-ids "$ID"    # resume: the platform is back in 1-3 minutes
aws ec2 describe-instances --instance-ids "$ID" \
  --query "Reservations[0].Instances[0].State.Name" --output text
```

Remove everything, including user apps (they run on the instance). This costs
nothing afterwards, but the data is gone; recreating gives a new Elastic IP, so
update the DNS record:

```bash
aws cloudformation delete-stack --stack-name cloud-platform
aws ssm delete-parameter --name /cloud-platform/admin-password
```

## CI/CD

`.github/workflows/ci.yml` runs on every push and pull request: format check,
typecheck, unit and database tests (against a PostgreSQL service) and build. A push
to `main` that passes is deployed: GitHub Actions signs in to AWS through OIDC (no
stored keys) with a role that may only run commands on the platform instance
(`deploy/aws/github-deploy.yaml`, stack `cloud-platform-ci`). The instance checks
out that commit and restarts the platform, then the workflow waits for
`/api/health/ready`. Deploys take about 5 minutes and run one at a time; the
dashboard is briefly unavailable while the platform restarts.

- **Roll back:** re-run the deploy job of an older run in the Actions tab, or push a revert.
- **Instance stopped:** the deploy job fails with "No running platform instance";
  start it and re-run the job.
- **Set up the role** (once per account):

  ```bash
  aws cloudformation deploy --stack-name cloud-platform-ci \
    --template-file deploy/aws/github-deploy.yaml --capabilities CAPABILITY_NAMED_IAM
  ```

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

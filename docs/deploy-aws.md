# Deploying to AWS

The platform runs on AWS as described in [`cloud_platform_baseline.md`](../cloud_platform_baseline.md): **GitHub Actions → Amazon ECR → Amazon ECS (Fargate) behind an Application Load Balancer**, with Amazon SQS, Amazon S3 and CloudWatch. PostgreSQL is Supabase (session pooler, TLS) instead of RDS. Every push to `main` is tested and deployed automatically.

```text
git push main ─▶ GitHub Actions ─(OIDC)─▶ ECR (api, worker, web, migrate images)
                     │                      │
                     ├─▶ run migrate task ──┤
                     └─▶ CloudFormation ImageTag update ─▶ ECS services roll (circuit breaker)

Browser ─HTTP─▶ ALB (AllowedCidr only)
                 ├─ /jobs, /jobs/*, /uploads, /health/* ─▶ api service (Fargate)
                 └─ everything else ─────────────────────▶ web service (Fargate)
api ─▶ SQS jobs ─▶ worker service (Fargate, 1–3 tasks, scales on queue depth) ─▶ S3 outputs/
api, worker, migrate ─▶ Supabase PostgreSQL          logs ─▶ CloudWatch /cloud-platform/ecs
```

| Stack               | Template                                                  | Holds                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform`    | [`infra/aws/ecs.yaml`](../infra/aws/ecs.yaml)             | VPC (2 public subnets), ALB, ECR repositories, ECS cluster, web/api/worker services, migrate task, SQS + DLQ, S3 bucket, log group, autoscaling, alarms, SNS alerts topic |
| `cloud-platform-ci` | [`infra/aws/github-ci.yaml`](../infra/aws/github-ci.yaml) | GitHub OIDC provider, `cloud-platform-github-deploy` role (main branch of this repo only), `cloud-platform-cfn-deploy` CloudFormation role                                |
| (parameter)         | —                                                         | SSM SecureString `/cloud-platform/staging/database-password`                                                                                                              |

Region: `ap-southeast-1`. The app URL is the `AppUrl` output of the `cloud-platform` stack.

## Start everything on AWS (from scratch)

Do this once, or again after a teardown. The whole environment takes about 15 minutes to create, plus one CI run. Commands use the AWS CLI v2 in `ap-southeast-1`, signed in with an administrator identity (`aws login`).

**Prerequisites:** an AWS account with services activated, a Supabase project and its database password, and push access to this GitHub repository.

1. **Sign in and pick the region**

   ```bash
   aws login --region ap-southeast-1
   aws sts get-caller-identity          # check the account
   export AWS_REGION=ap-southeast-1
   ```

2. **Store the database password** as an encrypted SSM parameter, without echoing it. Skip this if the parameter still exists, because teardown keeps it.

   ```bash
   read -rs DB_PASSWORD && aws ssm put-parameter --type SecureString --overwrite \
     --name /cloud-platform/staging/database-password --value "$DB_PASSWORD"; unset DB_PASSWORD
   ```

3. **Create the CI access stack.** Skip this if `cloud-platform-ci` still exists, because teardown keeps it too. Set `CreateOidcProvider=false` if the account already has the `token.actions.githubusercontent.com` provider. `GitHubRepositoryWithIds` is the ID form GitHub puts in its tokens. Find it in a failed `AssumeRoleWithWebIdentity` CloudTrail event, or derive it as `owner@<owner id>/repo@<repo id>` from `https://api.github.com/repos/<owner>/<repo>`.

   ```bash
   aws cloudformation create-stack --stack-name cloud-platform-ci \
     --template-body file://infra/aws/github-ci.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameters ParameterKey=GitHubRepository,ParameterValue=baltej223/cloud_native_deployment \
                  ParameterKey=GitHubRepositoryWithIds,ParameterValue=baltej223@73211864/cloud_native_deployment@1454983083
   aws cloudformation wait stack-create-complete --stack-name cloud-platform-ci
   ```

4. **Create the platform stack** with no images yet (`ImageTag=none`, so 0 tasks). Allow only your current IP. The database URL is the Supabase **session pooler** URL, without the password.

   ```bash
   aws cloudformation create-stack --stack-name cloud-platform \
     --template-body file://infra/aws/ecs.yaml --capabilities CAPABILITY_IAM \
     --parameters ParameterKey=AllowedCidr,ParameterValue=$(curl -s https://checkip.amazonaws.com)/32 \
                  ParameterKey=DatabaseUrl,ParameterValue='postgresql://postgres.<ref>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres'
   aws cloudformation wait stack-create-complete --stack-name cloud-platform
   ```

   On a brand-new account, the first attempt can fail with _"Unable to assume the service linked role"_ for the ECS cluster. AWS creates that role during the attempt, so delete the failed stack and run the command again.

5. **Deploy the app:** push to `main`, or run _Actions → CI / Deploy → Run workflow_ on `main`. The pipeline builds and pushes the images to ECR, runs the migrations, and starts the services.

6. **Open it:**

   ```bash
   aws cloudformation describe-stacks --stack-name cloud-platform \
     --query "Stacks[0].Outputs[?OutputKey=='AppUrl'].OutputValue" --output text
   ```

   Then upload an image in the browser. `/health/ready` should report `database`, `queue` and `storage` as `ok`.

While the `cloud-platform` stack doesn't exist, the deploy job only runs the checks and skips the AWS steps with a notice, so pushes still succeed.

## How a deploy works

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

1. **checks** (every push and pull request): `npm ci`, typecheck, tests, Prettier.
2. **deploy** (push to `main` only, after checks pass):
   1. Assume `cloud-platform-github-deploy` with GitHub OIDC. No AWS keys are stored in GitHub.
   2. Build the four Dockerfile targets and push them to ECR, tagged with the first 12 characters of the commit SHA. Tags are immutable. The web image is built with an empty `NEXT_PUBLIC_API_BASE_URL`, because the ALB serves the API on the same origin.
   3. Update the stack's `MigrateImageTag`, run the migrate task on Fargate, print its log and fail unless it exits with 0. Migrations therefore run **before** new code starts, so they must stay backward compatible.
   4. Update the stack's `ImageTag`. CloudFormation registers new task definitions and rolls the services, waiting until they are stable. The ECS deployment circuit breaker rolls back a version whose tasks never become healthy.

The deploy role can push images, run the migrate task and update the stack's parameters, and nothing else. It cannot read the database password. Template changes are not deployed by CI; an administrator applies them (see below).

## Runtime design

- **Secrets:** ECS injects `DATABASE_PASSWORD` from the SSM SecureString into the api, worker and migrate containers. It never appears in the template, parameters, outputs or logs.
- **Network:** tasks run in public subnets with public IPs. There is no NAT gateway, which saves about $33/month. Security groups allow inbound traffic only from the ALB (to web and api); worker and migrate allow no inbound traffic. The ALB accepts port 80 only from `AllowedCidr`.
- **Least privilege:** separate task roles. The api can send to the queue, write `uploads/` and `inputs/`, and read `outputs/`. The worker can receive from the queue, read `uploads/` and `inputs/`, and write `outputs/`. The execution role can read only the password parameter.
- **Database connections:** `DATABASE_POOL_MAX=2` per task keeps the total within Supabase's free session-pooler limit at full scale.
- **Health:** the ALB checks the api at `/health/live` and the web app at `/`. The worker's `stopTimeout` of 90 s lets in-flight image jobs (limited to 60 s) finish on scale-in or deploy.

## Retries, monitoring and scaling (Phase 6)

### Retries and the dead-letter queue

A failed attempt is retried by the worker with exponential backoff (5 s, 10 s, …), up to 3 attempts, then the job is marked `failed`. A message the worker can't handle at all goes to `cloud-platform-jobs-dlq` after 5 deliveries: a malformed body, or a failure while the database is down. The full rules are in [worker.md](worker.md).

**Dead-letter runbook**

1. The **DLQ alarm** fires (or the dashboard shows dead-letter messages).
2. Inspect them without removing them: `scripts/dlq.sh count`, then `scripts/dlq.sh peek 5`. Each body is `{version, jobId, type}`; follow a job's history in Logs Insights with `filter jobId = "<id>"`.
3. Fix the cause: deploy a code fix, restore the database, or discard messages that can never work.
4. Replay with `scripts/dlq.sh redrive`, which moves the messages back to `cloud-platform-jobs`, and check progress with `scripts/dlq.sh status`. Replaying is safe: the worker skips jobs that are already finished, and attempt fencing prevents duplicate results.

### Metrics, dashboard and alarms

The worker's JSON logs become metrics through log metric filters in namespace `CloudPlatform`, with no code involved:

| Metric              | From log line                               | Meaning                                      |
| ------------------- | ------------------------------------------- | -------------------------------------------- |
| `JobsCompleted`     | `msg = "job completed"`                     | Jobs finished successfully                   |
| `JobDuration` (ms)  | `durationMs` of `job completed`             | Processing time per job                      |
| `JobsFailed`        | `job attempt failed` with `terminal = true` | Jobs that ended `failed`                     |
| `JobAttemptsFailed` | `job attempt failed`                        | Every failed attempt, including retried ones |

The **CloudWatch dashboard** `cloud-platform` (stack output `DashboardUrl`) shows:

- queue depth (waiting, in progress, dead-letter) and the oldest waiting job;
- jobs per minute (completed, failed, retried) and processing time (p50, p90, max);
- CPU of the worker, api and web services, and the number of running worker tasks;
- API requests, 4xx and 5xx counts, and p50 and p90 response times;
- the state of every alarm.

| Alarm             | Fires when                                                     |
| ----------------- | -------------------------------------------------------------- |
| Dead-letter queue | Any message in `cloud-platform-jobs-dlq`                       |
| Backlog age       | The oldest waiting job is older than 5 minutes, for 10 minutes |
| Job failures      | More than 5 jobs fail permanently in 15 minutes                |
| API 5xx           | More than 10 target 5xx responses in 5 minutes                 |
| Unhealthy API     | Any unhealthy api target for 5 minutes                         |

Alarms publish to the `cloud-platform-alerts` SNS topic. Set the stack parameter `AlertEmail` to receive them by email (confirm the subscription email AWS sends), or subscribe in the SNS console.

### Scaling

| Service | Rule                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| Worker  | 1–3 tasks (`WorkerMaxTasks`). +1 when ≥ 5 jobs are waiting, +2 when ≥ 25; −1 after 5 minutes with an empty queue |
| API     | 1–2 tasks, target tracking at 60% average CPU (never on queue depth)                                             |

Scale-in never interrupts a job. ECS sends SIGTERM, the worker stops polling and finishes its in-flight job (image jobs are limited to 60 s; `stopTimeout` is 90 s), then exits. A message that is still unfinished reappears after the visibility timeout and is retried.

**Verifying autoscaling** (about 30 minutes of running cost):

```bash
URL=$(aws cloudformation describe-stacks --stack-name cloud-platform \
  --query "Stacks[0].Outputs[?OutputKey=='AppUrl'].OutputValue" --output text)
npm run load-test -- --url "$URL" --jobs 300 --concurrency 20 --size 3000
```

On the dashboard, the waiting count should rise above 5 and the running worker tasks should go 1 → 2 → 3. When the queue drains, the completed count should catch up. About 5 minutes after the queue empties, the workers should scale back in one task at a time to 1. ECS → `worker` → _Events_ records each scaling activity.

## Operations

| Task                   | How                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy                 | Push to `main`, or run the workflow manually (_Actions → CI / Deploy → Run workflow_)                                                                                                                                                   |
| Roll back              | Re-run the deploy job of an earlier commit, or `update-stack` with an older `ImageTag`                                                                                                                                                  |
| Your IP changed        | `aws cloudformation update-stack --stack-name cloud-platform --use-previous-template --capabilities CAPABILITY_IAM --parameters ParameterKey=AllowedCidr,ParameterValue=<ip>/32` plus `UsePreviousValue=true` for every other parameter |
| Apply template changes | `update-stack --template-body file://infra/aws/ecs.yaml` with `UsePreviousValue=true` for all parameters (administrator credentials)                                                                                                    |
| Follow one job         | Logs Insights on `/cloud-platform/ecs`: `fields @timestamp, @logStream, msg \| filter jobId = "<id>" \| sort @timestamp`                                                                                                                |
| Pause to save credits  | Set `ImageTag=none` (all services go to 0 tasks; the ALB still costs ~$0.6/day)                                                                                                                                                         |
| Rotate the DB password | Update it in Supabase, `aws ssm put-parameter --overwrite --type SecureString …`, then redeploy so tasks restart                                                                                                                        |

## Cost (approximate, if left running)

| Item                                                               | ~ per month |
| ------------------------------------------------------------------ | ----------- |
| Application Load Balancer                                          | ~$18        |
| Fargate: web + api (0.25 vCPU/0.5 GB each), worker (0.5 vCPU/1 GB) | ~$36        |
| Public IPv4 addresses (ALB + tasks)                                | ~$18        |
| ECR storage, CloudWatch Logs, SQS, S3, SSM                         | ~$1–3       |

## Tear down (stop all costs)

After CI has deployed, CloudFormation remembers CI's narrow `cloud-platform-cfn-deploy` role for the stack, and that role is deliberately not allowed to delete anything. Delete with a short-lived administrator role instead:

```bash
aws iam create-role --role-name cloud-platform-cfn-teardown \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"cloudformation.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name cloud-platform-cfn-teardown \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
sleep 15
BUCKET=$(aws cloudformation describe-stacks --stack-name cloud-platform \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
aws cloudformation delete-stack --stack-name cloud-platform \
  --role-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/cloud-platform-cfn-teardown
aws cloudformation wait stack-delete-complete --stack-name cloud-platform
# The files bucket is retained on purpose (it can hold data): empty and delete it.
aws s3 rm s3://$BUCKET --recursive && aws s3api delete-bucket --bucket $BUCKET
# Remove the temporary role.
aws iam detach-role-policy --role-name cloud-platform-cfn-teardown --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam delete-role --role-name cloud-platform-cfn-teardown
```

This deletes the ALB, ECS services, ECR repositories and their images, queues, alarms and logs: everything that costs money. It keeps the free parts, so starting again is quicker:

- the `cloud-platform-ci` stack (IAM roles and the OIDC provider);
- the SSM password parameter.

To remove those as well:

```bash
aws cloudformation delete-stack --stack-name cloud-platform-ci
aws ssm delete-parameter --name /cloud-platform/staging/database-password
```

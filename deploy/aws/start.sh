#!/bin/bash
# Starts the platform on the EC2 instance (run by cloud-platform.service on boot).
# The domain and admin password come from SSM Parameter Store; Caddy serves
# https://$DOMAIN and apps on https://<project>.$DOMAIN.
set -euo pipefail
cd "$(dirname "$0")/../.."

token=$(curl -sf -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
AWS_REGION=$(curl -sf -H "X-aws-ec2-metadata-token: $token" \
  http://169.254.169.254/latest/meta-data/placement/region)
export AWS_REGION

# The AWS CLI runs in a container on the host network: instance metadata
# allows one network hop, so app containers cannot reach the instance role.
parameter() {
  docker run --rm --network host -e AWS_REGION docker.io/amazon/aws-cli:2.27.50 \
    ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text
}
DOMAIN=$(parameter /cloud-platform/domain)
if ! ADMIN_PASSWORD=$(parameter /cloud-platform/admin-password); then
  echo "Create the SecureString parameter /cloud-platform/admin-password first." >&2
  exit 1
fi

# Session cookies stay valid across restarts: keep the signing key on disk.
secret_file=/var/lib/cloud-platform/session-secret
if [ ! -s "$secret_file" ]; then
  install -d -m 700 "$(dirname "$secret_file")"
  (umask 077 && openssl rand -hex 32 > "$secret_file")
fi

export DOMAIN ADMIN_PASSWORD
SESSION_SECRET=$(cat "$secret_file")
export SESSION_SECRET
export SECURE_COOKIES=true
export APP_PUBLIC_HOST="$DOMAIN"
# Apps get https://<project>.$DOMAIN (DNS: a wildcard record *.$DOMAIN).
export APP_DOMAIN="$DOMAIN"
export WEB_ORIGIN="https://$DOMAIN"
export NEXT_PUBLIC_API_BASE_URL=/api
export NODE_ENV=production
# A free-tier instance has 1 GiB of memory: keep apps small and few.
export APP_MEMORY_MB="${APP_MEMORY_MB:-256}"
export MAX_PROJECTS="${MAX_PROJECTS:-5}"
export AUTO_STOP_IDLE_MINUTES="${AUTO_STOP_IDLE_MINUTES:-30}"
export DATABASE_POOL_MAX=5

docker compose -f compose.yaml -f deploy/aws/compose.proxy.yaml up -d --build --remove-orphans
docker image prune -f

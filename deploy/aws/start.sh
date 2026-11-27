#!/bin/bash
# Starts the platform on the EC2 instance (run by cloud-platform.service on boot).
# Reads the instance's current public IP so the dashboard, API and app URLs match it.
set -euo pipefail
cd "$(dirname "$0")/../.."

token=$(curl -sf -X PUT http://169.254.169.254/latest/api/token \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
ip=$(curl -sf -H "X-aws-ec2-metadata-token: $token" \
  http://169.254.169.254/latest/meta-data/public-ipv4)

# Settings for this host. A database password, if any, goes in .env (never committed).
export APP_PUBLIC_HOST="$ip"
export WEB_ORIGIN="http://$ip:3000"
export NEXT_PUBLIC_API_BASE_URL="http://$ip:3001"
export NODE_ENV=production
# A free-tier instance has 1 GiB of memory: keep apps small and few.
export APP_MEMORY_MB="${APP_MEMORY_MB:-256}"
export MAX_PROJECTS="${MAX_PROJECTS:-5}"
export AUTO_STOP_IDLE_MINUTES="${AUTO_STOP_IDLE_MINUTES:-30}"
export DATABASE_POOL_MAX=5

docker compose up -d --build --remove-orphans
docker image prune -f

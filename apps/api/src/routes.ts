import { appName, serviceContainerName } from "@cloud-platform/drivers";
import type { ProjectRepository, ProjectWithLatest } from "@cloud-platform/platform";
import express, { type Router } from "express";

/**
 * Host-name routing for the reverse proxy (deploy/aws/Caddyfile):
 * <project>.<domain> goes to the app, <service>.<project>.<domain> to a compose
 * service that publishes ports. Caddy asks /routes/check before getting a
 * certificate for a name, and /routes/resolve (forward_auth) for each request.
 */
export const ROUTE_PATHS = ["/routes/check", "/routes/resolve"];
export const UPSTREAM_HEADER = "x-cp-upstream";
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const CACHE_MS = 3_000;

type Target = { upstream: string; running: boolean };

/** Compose services of the live deployment that get their own URL. */
export function routedServices(entry: ProjectWithLatest): Array<{ name: string; port: number }> {
  const plan = entry.live?.compose;
  if (!plan) return [];
  return plan.services.flatMap((service) =>
    service.name !== plan.publicService &&
    service.httpPort &&
    DNS_LABEL.test(service.name.toLowerCase())
      ? [{ name: service.name, port: service.httpPort }]
      : [],
  );
}

export function createRoutes(repository: ProjectRepository, domain: string): Router {
  const suffix = `.${domain.toLowerCase()}`;
  let table = new Map<string, Target>();
  let loadedAt = 0;
  let loading: Promise<void> | null = null;

  async function load() {
    const next = new Map<string, Target>();
    for (const entry of await repository.list()) {
      const { project, live } = entry;
      if (project.deletedAt || !live?.containerPort) continue;
      const running = project.desiredState === "running";
      next.set(project.name, {
        upstream: `${appName(project.id)}:${live.containerPort}`,
        running,
      });
      for (const service of routedServices(entry)) {
        next.set(`${service.name.toLowerCase()}.${project.name}`, {
          upstream: `${serviceContainerName(project.id, service.name)}:${service.port}`,
          running,
        });
      }
    }
    table = next;
    loadedAt = Date.now();
  }

  async function lookup(host: string | undefined): Promise<Target | null> {
    const name = (host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!name.endsWith(suffix)) return null;
    if (Date.now() - loadedAt > CACHE_MS) {
      loading ??= load().finally(() => (loading = null));
      await loading;
    }
    return table.get(name.slice(0, -suffix.length)) ?? null;
  }

  const router = express.Router();

  router.get("/routes/check", async (request, response) => {
    const target = await lookup(String(request.query.domain ?? ""));
    response.status(target ? 200 : 404).end();
  });

  router.get("/routes/resolve", async (request, response) => {
    const target = await lookup(request.header("x-forwarded-host") ?? request.header("host"));
    if (!target) {
      response.status(404).type("text").send("No app is deployed at this address.\n");
      return;
    }
    if (!target.running) {
      response.status(503).type("text").send("This app is stopped. Start it from the dashboard.\n");
      return;
    }
    response.setHeader(UPSTREAM_HEADER, target.upstream);
    response.status(200).end();
  });

  return router;
}

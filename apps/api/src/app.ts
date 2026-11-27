import { randomUUID } from "node:crypto";
import type { ListDeploymentsResponse, ListProjectsResponse } from "@cloud-platform/contracts";
import type { Logger } from "@cloud-platform/platform";
import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { type AuthOptions, createAuth } from "./auth.js";
import { HttpError } from "./errors.js";
import { createRoutes } from "./routes.js";
import type { ProjectRepository } from "@cloud-platform/platform";
import type { ProjectsService } from "./projects-service.js";

export interface AppDependencies {
  projects: ProjectsService;
  logger: Logger;
  allowedOrigins: string[];
  /** Resolve when every required dependency is reachable; reject otherwise. */
  readinessChecks: Record<string, () => Promise<void>>;
  /** Admin login; omitted or without a password, every request is allowed. */
  auth?: AuthOptions;
  /** Host-name routing for the reverse proxy, when apps get subdomains. */
  routing?: { repository: ProjectRepository; domain: string };
}

const READINESS_TIMEOUT_MS = 2_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    promise,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref()),
  ]);
}

export function createApp({
  projects,
  logger,
  allowedOrigins,
  readinessChecks,
  auth = { password: "", secureCookie: false },
  routing,
}: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy on a private network: use its X-Forwarded-For.
  app.set("trust proxy", "loopback, uniquelocal");
  const { router: authRouter, guard } = createAuth(auth);

  const requestLogger: RequestHandler = (request, response, next) => {
    const requestId = request.header("x-request-id") ?? randomUUID();
    const started = process.hrtime.bigint();
    response.setHeader("x-request-id", requestId);
    response.on("finish", () => {
      if (request.path.startsWith("/health")) return;
      logger.info(
        {
          requestId,
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        },
        "request completed",
      );
    });
    next();
  };

  app.use(requestLogger);
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  // Asked by the proxy, not the browser: before the login check.
  if (routing) app.use(createRoutes(routing.repository, routing.domain));
  app.use(authRouter);
  app.use(guard);

  app.get("/health/live", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/health/ready", async (_request, response) => {
    const entries = await Promise.all(
      Object.entries(readinessChecks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), READINESS_TIMEOUT_MS);
          return [name, "ok"] as const;
        } catch (error) {
          logger.warn({ dependency: name, err: error }, "readiness check failed");
          return [name, "unavailable"] as const;
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    const ready = entries.every(([, state]) => state === "ok");
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
  });

  app.post("/projects", async (request, response) => {
    const created = await projects.create(request.body);
    response.status(201).location(`/projects/${created.project.id}`).json(created);
  });

  app.get("/projects", async (_request, response) => {
    const body: ListProjectsResponse = { projects: await projects.list() };
    response.setHeader("Cache-Control", "no-store");
    response.json(body);
  });

  app.get("/projects/:id", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(await projects.get(request.params.id));
  });

  app.delete("/projects/:id", async (request, response) => {
    await projects.delete(request.params.id);
    response.status(202).json({ id: request.params.id, status: "deleting" });
  });

  app.patch("/projects/:id", async (request, response) => {
    response.json(await projects.update(request.params.id, request.body));
  });

  app.post("/projects/:id/stop", async (request, response) => {
    response.status(202).json(await projects.stop(request.params.id));
  });

  app.post("/projects/:id/start", async (request, response) => {
    response.status(202).json(await projects.start(request.params.id));
  });

  app.post("/projects/:id/rollback", async (request, response) => {
    const deployment = await projects.rollback(request.params.id, request.body);
    response.status(202).location(`/deployments/${deployment.id}`).json(deployment);
  });

  app.get("/projects/:id/logs", async (request, response) => {
    const { service, tail } = request.query;
    response.setHeader("Cache-Control", "no-store");
    response.json(
      await projects.runtimeLogs(
        request.params.id,
        typeof service === "string" && service ? service : undefined,
        typeof tail === "string" ? tail : undefined,
      ),
    );
  });

  app.post("/projects/:id/deployments", async (request, response) => {
    const deployment = await projects.redeploy(request.params.id);
    response.status(202).location(`/deployments/${deployment.id}`).json(deployment);
  });

  app.get("/projects/:id/deployments", async (request, response) => {
    const body: ListDeploymentsResponse = {
      deployments: await projects.listDeployments(request.params.id),
    };
    response.setHeader("Cache-Control", "no-store");
    response.json(body);
  });

  app.get("/deployments/:id", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(await projects.getDeployment(request.params.id));
  });

  app.get("/deployments/:id/logs", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(await projects.getBuildLog(request.params.id));
  });

  app.use((_request, _response, next) => {
    next(new HttpError(404, "NOT_FOUND", "Route not found."));
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof HttpError) {
      response.status(error.status).json(error.toBody());
      return;
    }
    // Errors raised by express.json() for malformed or oversized bodies.
    if (error?.type === "entity.parse.failed") {
      response
        .status(400)
        .json(new HttpError(400, "INVALID_INPUT", "Request body must be valid JSON.").toBody());
      return;
    }
    if (error?.type === "entity.too.large") {
      response
        .status(413)
        .json(new HttpError(413, "INVALID_INPUT", "Request body is too large.").toBody());
      return;
    }
    logger.error({ err: error }, "unhandled request error");
    response
      .status(500)
      .json(new HttpError(500, "INTERNAL_ERROR", "Something went wrong.").toBody());
  };
  app.use(errorHandler);

  return app;
}

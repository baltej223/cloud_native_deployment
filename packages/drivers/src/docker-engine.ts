import { request } from "node:http";
import type { Readable } from "node:stream";

/**
 * Minimal client for the Docker Engine API over a Unix socket. Podman serves
 * the same API, so this works with either engine. Only the calls the platform
 * needs are implemented.
 */
export class DockerEngine {
  /** Docker-compatible API version; supported by Docker 20.10+ and Podman 4+. */
  private readonly prefix = "/v1.41";

  constructor(readonly socketPath: string) {}

  async ping(): Promise<void> {
    const response = await this.call("GET", "/_ping");
    if (response.status !== 200) throw new EngineError(response.status, response.body);
  }

  /**
   * Pull an image. The engine streams JSON progress lines and reports a failed
   * pull either as an HTTP error or as an `error` line in the stream.
   */
  async pull(image: string, timeoutMs: number): Promise<void> {
    const response = await this.call(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(image)}`,
      undefined,
      timeoutMs,
    );
    if (response.status !== 200) throw new EngineError(response.status, response.body);
    for (const line of response.body.split("\n")) {
      if (!line.trim()) continue;
      let message: { error?: string; errorDetail?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const error = message.errorDetail?.message ?? message.error;
      if (error) throw new EngineError(500, error);
    }
  }

  async createContainer(name: string, spec: unknown): Promise<void> {
    const response = await this.call(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      spec,
    );
    if (response.status !== 201) throw new EngineError(response.status, response.body);
  }

  async startContainer(name: string): Promise<void> {
    const response = await this.call("POST", `/containers/${encodeURIComponent(name)}/start`);
    // 304: already running.
    if (response.status !== 204 && response.status !== 304) {
      throw new EngineError(response.status, response.body);
    }
  }

  /** Container details, or null if there is no such container. */
  async inspectContainer(name: string): Promise<ContainerInspect | null> {
    const response = await this.call("GET", `/containers/${encodeURIComponent(name)}/json`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new EngineError(response.status, response.body);
    return JSON.parse(response.body) as ContainerInspect;
  }

  /** Force-remove a container. Succeeds if it does not exist. */
  async removeContainer(name: string): Promise<void> {
    const response = await this.call(
      "DELETE",
      `/containers/${encodeURIComponent(name)}?force=true&v=true`,
    );
    if (response.status !== 204 && response.status !== 404) {
      throw new EngineError(response.status, response.body);
    }
  }

  /**
   * Build an image from a tar stream of the build context. Output lines
   * (`stream`) go to `onOutput`; a build error is thrown as an EngineError.
   */
  async build(
    context: Readable,
    options: { tag: string; dockerfile: string; signal: AbortSignal },
    onOutput: (text: string) => void,
  ): Promise<void> {
    const query = new URLSearchParams({
      t: options.tag,
      dockerfile: options.dockerfile,
      rm: "1",
      forcerm: "1",
    });
    await new Promise<void>((resolve, reject) => {
      let failure: string | undefined;
      let pending = "";
      let status = 0;
      let body = "";

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let message: {
          stream?: string;
          status?: string;
          error?: string;
          errorDetail?: { message?: string };
          message?: string;
        };
        try {
          message = JSON.parse(line);
        } catch {
          onOutput(`${line}\n`);
          return;
        }
        if (message.stream) onOutput(message.stream);
        else if (message.status) onOutput(`${message.status}\n`);
        const error = message.errorDetail?.message ?? message.error;
        if (error) failure = error;
      };

      const req = request(
        {
          socketPath: this.socketPath,
          method: "POST",
          path: `${this.prefix}/build?${query}`,
          headers: { Host: "docker", "Content-Type": "application/x-tar" },
          signal: options.signal,
        },
        (res) => {
          status = res.statusCode ?? 0;
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            if (status !== 200) {
              body += chunk;
              return;
            }
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? "";
            lines.forEach(handleLine);
          });
          res.on("end", () => {
            if (status !== 200) return reject(new EngineError(status, body));
            handleLine(pending);
            if (failure) reject(new EngineError(500, JSON.stringify({ message: failure })));
            else resolve();
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      context.on("error", (error) => req.destroy(error));
      context.pipe(req);
    });
  }

  /** Remove an image. Succeeds if it does not exist or is still in use. */
  async removeImage(name: string): Promise<void> {
    const response = await this.call("DELETE", `/images/${encodeURIComponent(name)}`);
    if (![200, 404, 409].includes(response.status)) {
      throw new EngineError(response.status, response.body);
    }
  }

  /** Create a bridge network unless it already exists. */
  async ensureNetwork(name: string): Promise<void> {
    const existing = await this.call("GET", `/networks/${encodeURIComponent(name)}`);
    if (existing.status === 200) return;
    if (existing.status !== 404) throw new EngineError(existing.status, existing.body);
    const created = await this.call("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      Labels: { "cloud-platform.network": "apps" },
    });
    // 409: created concurrently by someone else.
    if (created.status !== 201 && created.status !== 409) {
      throw new EngineError(created.status, created.body);
    }
  }

  private call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<{ status: number; body: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path: path === "/_ping" ? path : `${this.prefix}${path}`,
          headers: {
            Host: "docker",
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
              : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error(`container engine timed out after ${timeoutMs} ms`)),
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

export interface ContainerInspect {
  State: {
    Status: "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead";
    ExitCode: number;
    /** RFC 3339; "0001-01-01T00:00:00Z" when never started. */
    StartedAt?: string;
  };
  RestartCount: number;
  Config: { Labels: Record<string, string> | null };
}

/** An error response from the container engine. */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(EngineError.messageFrom(body));
    this.name = "EngineError";
  }

  private static messageFrom(body: string): string {
    try {
      const parsed = JSON.parse(body) as { message?: string; cause?: string };
      if (parsed.message) return parsed.message;
    } catch {
      // Not JSON: use the raw text.
    }
    return body.trim() || "container engine error";
  }
}

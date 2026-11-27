import { request } from "node:http";

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

  /** Stop a container (SIGTERM, then SIGKILL after `seconds`). Succeeds if it is stopped or gone. */
  async stopContainer(name: string, seconds = 10): Promise<void> {
    const response = await this.call(
      "POST",
      `/containers/${encodeURIComponent(name)}/stop?t=${seconds}`,
      undefined,
      (seconds + 20) * 1000,
    );
    if (![204, 304, 404].includes(response.status)) {
      throw new EngineError(response.status, response.body);
    }
  }

  /** The last `tail` lines of a container's stdout and stderr, or null if it does not exist. */
  async containerLogs(name: string, tail: number): Promise<string | null> {
    const response = await this.callRaw(
      "GET",
      `/containers/${encodeURIComponent(name)}/logs?stdout=true&stderr=true&timestamps=true&tail=${tail}`,
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new EngineError(response.status, response.body.toString("utf8"));
    }
    return demultiplex(response.body);
  }

  /** Total bytes received on all networks, or null if the container is not running. */
  async receivedBytes(name: string): Promise<number | null> {
    const response = await this.call(
      "GET",
      `/containers/${encodeURIComponent(name)}/stats?stream=false&one-shot=true`,
    );
    if (response.status === 404) return null;
    if (response.status !== 200) throw new EngineError(response.status, response.body);
    const stats = JSON.parse(response.body) as {
      networks?: Record<string, { rx_bytes: number }>;
    };
    if (!stats.networks) return null;
    return Object.values(stats.networks).reduce((sum, network) => sum + network.rx_bytes, 0);
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

  /** Remove an image. Succeeds if it does not exist or is still in use. */
  async removeImage(name: string): Promise<void> {
    const response = await this.call("DELETE", `/images/${encodeURIComponent(name)}`);
    if (![200, 404, 409].includes(response.status)) {
      throw new EngineError(response.status, response.body);
    }
  }

  /** Names of containers (running or not) that carry the given label. */
  async listContainers(label: string): Promise<string[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const response = await this.call("GET", `/containers/json?all=true&filters=${filters}`);
    if (response.status !== 200) throw new EngineError(response.status, response.body);
    return (JSON.parse(response.body) as Array<{ Names: string[] }>).map((container) =>
      container.Names[0]!.replace(/^\//, ""),
    );
  }

  /** Create a named volume; an existing one is kept. */
  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    const response = await this.call("POST", "/volumes/create", { Name: name, Labels: labels });
    if (response.status !== 201 && response.status !== 200) {
      throw new EngineError(response.status, response.body);
    }
  }

  /** Names of volumes that carry the given label. */
  async listVolumes(label: string): Promise<string[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const response = await this.call("GET", `/volumes?filters=${filters}`);
    if (response.status !== 200) throw new EngineError(response.status, response.body);
    const body = JSON.parse(response.body) as { Volumes: Array<{ Name: string }> | null };
    return (body.Volumes ?? []).map((volume) => volume.Name);
  }

  /** Remove a volume. Succeeds if it does not exist. */
  async removeVolume(name: string): Promise<void> {
    const response = await this.call("DELETE", `/volumes/${encodeURIComponent(name)}?force=true`);
    if (response.status !== 204 && response.status !== 404) {
      throw new EngineError(response.status, response.body);
    }
  }

  /** Attach a (not yet started) container to another network under extra host names. */
  async connectNetwork(network: string, container: string, aliases: string[]): Promise<void> {
    const response = await this.call("POST", `/networks/${encodeURIComponent(network)}/connect`, {
      Container: container,
      EndpointConfig: { Aliases: aliases },
    });
    if (response.status !== 200) throw new EngineError(response.status, response.body);
  }

  /** Remove a network. Succeeds if it does not exist. */
  async removeNetwork(name: string): Promise<void> {
    const response = await this.call("DELETE", `/networks/${encodeURIComponent(name)}`);
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw new EngineError(response.status, response.body);
    }
  }

  /** Create a bridge network unless it already exists. */
  async ensureNetwork(
    name: string,
    labels: Record<string, string> = { "cloud-platform.network": "apps" },
  ): Promise<void> {
    const existing = await this.call("GET", `/networks/${encodeURIComponent(name)}`);
    if (existing.status === 200) return;
    if (existing.status !== 404) throw new EngineError(existing.status, existing.body);
    const created = await this.call("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      Labels: labels,
    });
    // 409: created concurrently by someone else.
    if (created.status !== 201 && created.status !== 409) {
      throw new EngineError(created.status, created.body);
    }
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<{ status: number; body: string }> {
    const response = await this.callRaw(method, path, body, timeoutMs);
    return { status: response.status, body: response.body.toString("utf8") };
  }

  private callRaw(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<{ status: number; body: Buffer }> {
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
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
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

/**
 * Container logs without a TTY come as frames: an 8-byte header (stream type,
 * three zero bytes, big-endian length) followed by the payload.
 */
export function demultiplex(buffer: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (
    offset + 8 <= buffer.length &&
    buffer[offset]! <= 2 &&
    buffer.readUIntBE(offset + 1, 3) === 0
  ) {
    const length = buffer.readUInt32BE(offset + 4);
    parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  // Not framed (a container with a TTY): the body is the plain log.
  if (offset === 0) return buffer.toString("utf8");
  return Buffer.concat(parts).toString("utf8");
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

import { IMAGE_REFERENCE_PATTERN, normalizeImageReference } from "@cloud-platform/contracts";
import { posix } from "node:path";
import { parse } from "yaml";
import { DeployError, type ServiceSpec, type VolumeMount } from "./types.js";

/**
 * Compose files the platform recognises at the repository root, in the order
 * Docker Compose itself prefers them.
 */
export const COMPOSE_FILE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

export const DEFAULT_MAX_COMPOSE_SERVICES = 5;

/** How a service gets its image: built from the repository, or pulled. */
export interface ServiceBuild {
  /** Build context, relative to the repository root ("." for the root). */
  context: string;
  /** Dockerfile, relative to the build context. */
  dockerfile: string;
  args: Record<string, string>;
  target: string | null;
}

export interface ParsedService extends Omit<ServiceSpec, "image" | "pull" | "httpPort"> {
  /** Registry image, fully qualified; null when the service is built. */
  image: string | null;
  build: ServiceBuild | null;
  /** True if the service publishes a port (`ports:`). */
  publishes: boolean;
  /** Port the service listens on: the first `ports:` target, else the first `expose:`. */
  port: number | null;
  /**
   * Repository folders the service mounts (often its source code in
   * development setups). The platform cannot mount the clone, so it copies
   * them into the image instead.
   */
  copies: Array<{ source: string; target: string }>;
}

export interface ParsedCompose {
  /** Services in start order: dependencies first. */
  services: ParsedService[];
  /** Things in the file the platform ignores, to show in the build log. */
  warnings: string[];
}

export interface ParseComposeOptions {
  /** Compose file path, relative to the repository root. */
  file: string;
  /** Variables for ${VAR}: the project's variables (they win over the repository's .env). */
  env: Record<string, string>;
  /** Read a file inside the repository (POSIX path from the root); null if it does not exist. */
  readFile: (path: string) => string | null;
  maxServices?: number;
}

/**
 * Settings that would give an app power over the machine or other apps. A
 * compose file using any of them is refused.
 */
const REFUSED_SERVICE_KEYS: Record<string, string> = {
  privileged: "runs the container privileged",
  cap_add: "adds kernel capabilities",
  devices: "uses host devices",
  device_cgroup_rules: "uses host devices",
  network_mode: "changes the network mode",
  pid: "shares the host's process list",
  ipc: "shares inter-process communication",
  uts: "shares the host name",
  userns_mode: "changes the user namespace",
  security_opt: "changes security options",
  cgroup_parent: "changes the control group",
  cgroup: "changes the control group",
  volumes_from: "mounts another container's volumes",
  runtime: "changes the container runtime",
  isolation: "changes the isolation",
  group_add: "adds groups",
  oom_kill_disable: "disables the out-of-memory killer",
  sysctls: "changes kernel settings",
  extends: "extends another file (not supported)",
  secrets: "uses secrets (not supported; use the project's environment variables)",
  configs: "uses configs (not supported)",
};

/** Settings the platform applies. Everything else is ignored, with a warning. */
const HANDLED_SERVICE_KEYS = new Set([
  "image",
  "build",
  "command",
  "entrypoint",
  "environment",
  "env_file",
  "ports",
  "expose",
  "depends_on",
  "restart",
  "volumes",
  "working_dir",
  "user",
  "profiles",
]);

/** Ignored silently: harmless, or replaced by the platform's own choice. */
const QUIET_SERVICE_KEYS = new Set([
  "container_name",
  "networks",
  "labels",
  "healthcheck",
  "deploy",
  "mem_limit",
  "memswap_limit",
  "cpus",
  "cpu_shares",
  "hostname",
  "stdin_open",
  "tty",
  "init",
  "platform",
  "pull_policy",
  "stop_grace_period",
  "stop_signal",
  "logging",
  "links",
]);

const REFUSED_TOP_LEVEL_KEYS: Record<string, string> = {
  secrets: "secrets are not supported; use the project's environment variables",
  configs: "configs are not supported",
  include: "include is not supported; put all services in one file",
};

const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isActive = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  !(Array.isArray(value) && value.length === 0) &&
  !(isMapping(value) && Object.keys(value).length === 0);

/** Variables from a .env file: KEY=VALUE lines, optional quotes and `export`. */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, "");
    result[match[1]!] = value;
  }
  return result;
}

/**
 * Replace ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?error}, ${VAR:+alt}
 * and $VAR as Docker Compose does; $$ is a literal $.
 */
export function interpolate(value: string, vars: Record<string, string>, where: string): string {
  return value.replace(
    /\$(?:\$|\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced: string | undefined, bare: string | undefined) => {
      if (match === "$$") return "$";
      if (bare !== undefined) return vars[bare] ?? "";
      const parts = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/.exec(braced ?? "");
      if (!parts) throw new DeployError(`${where}: \${${braced}} is not a valid variable.`);
      const [, name, operator, argument = ""] = parts;
      const value = vars[name!];
      const set = value !== undefined;
      const nonEmpty = set && value !== "";
      switch (operator) {
        case undefined:
          return value ?? "";
        case ":-":
          return nonEmpty ? value! : argument;
        case "-":
          return set ? value! : argument;
        case ":+":
          return nonEmpty ? argument : "";
        case "+":
          return set ? argument : "";
        default: // ":?" and "?"
          if (operator === ":?" ? !nonEmpty : !set) {
            throw new DeployError(
              `${where} needs the variable ${name}${argument ? ` (${argument})` : ""}. Add it to the project's environment variables.`,
            );
          }
          return value!;
      }
    },
  );
}

function interpolateAll(value: unknown, vars: Record<string, string>, where: string): unknown {
  if (typeof value === "string") return interpolate(value, vars, where);
  if (Array.isArray(value)) return value.map((item) => interpolateAll(item, vars, where));
  if (isMapping(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateAll(item, vars, where)]),
    );
  }
  return value;
}

/** Split a command string like a POSIX shell does (quotes and backslashes). */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < command.length) {
      current += command[++i];
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (quote) throw new DeployError(`The command ${command} has an unclosed quote.`);
  if (inWord) words.push(current);
  return words;
}

/** A path inside the repository, or null if it leaves it. */
function insideRepo(path: string): string | null {
  const normalized = posix.normalize(path).replace(/\/+$/, "") || ".";
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function toPort(value: unknown): number | null {
  const number = Number(String(value).split("-")[0]);
  return Number.isInteger(number) && number >= 1 && number <= 65_535 ? number : null;
}

/** The container side of a `ports:` entry: "80", "8080:80", "127.0.0.1:8080:80/tcp", {target: 80}. */
export function containerPortOf(entry: unknown): number | null {
  if (isMapping(entry)) return toPort(entry.target);
  const text = String(entry).split("/")[0]!;
  return toPort(text.slice(text.lastIndexOf(":") + 1));
}

function stringMap(value: unknown, where: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item);
      const equals = text.indexOf("=");
      if (equals === -1) result[text] = null;
      else result[text.slice(0, equals)] = text.slice(equals + 1);
    }
  } else if (isMapping(value)) {
    for (const [key, item] of Object.entries(value)) {
      result[key] = item === null || item === undefined ? null : String(item);
    }
  } else if (value !== undefined && value !== null) {
    throw new DeployError(`${where} must be a list or a mapping.`);
  }
  return result;
}

const toCommand = (value: unknown): string[] | null => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(String);
  return splitCommand(String(value));
};

function restartPolicy(value: unknown): ServiceSpec["restart"] {
  const text = value === undefined || value === null ? "" : String(value);
  if (text === "no" || text === "false") return "no";
  if (text === "always") return "always";
  if (text.startsWith("on-failure")) return "on-failure";
  // Unset: keep the app running, like the platform's single-container apps.
  return "unless-stopped";
}

/**
 * Read a compose file and turn it into services the platform can run, or fail
 * with a reason the user can act on. Only named volumes are allowed; settings
 * that reach into the host (privileged, host folders, host network, devices…)
 * are refused.
 */
export function parseCompose(text: string, options: ParseComposeOptions): ParsedCompose {
  const { file } = options;
  const directory = posix.dirname(file);
  const warnings: string[] = [];

  let document: unknown;
  try {
    document = parse(text, { maxAliasCount: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new DeployError(`${file} is not valid YAML: ${message}`);
  }
  if (!isMapping(document) || !isMapping(document.services)) {
    throw new DeployError(`${file} has no services.`);
  }
  for (const [key, reason] of Object.entries(REFUSED_TOP_LEVEL_KEYS)) {
    if (isActive(document[key])) throw new DeployError(`${file}: ${reason}.`);
  }

  // Variables: the repository's .env next to the compose file, then the project's.
  const dotEnvPath = directory === "." ? ".env" : `${directory}/.env`;
  const dotEnv = options.readFile(dotEnvPath);
  const vars = { ...(dotEnv ? parseEnvFile(dotEnv) : {}), ...options.env };

  // Top-level volumes: only plain named volumes managed by the platform.
  const declaredVolumes = isMapping(document.volumes) ? document.volumes : {};
  for (const [name, definition] of Object.entries(declaredVolumes)) {
    if (!VOLUME_NAME_PATTERN.test(name)) {
      throw new DeployError(`${file}: volume name ${name} is not valid.`);
    }
    if (isMapping(definition) && (definition.external || definition.driver_opts)) {
      throw new DeployError(
        `${file}: volume ${name} uses an external volume or driver options, which is not allowed. Use a plain named volume.`,
      );
    }
  }

  const services: ParsedService[] = [];
  const skipped: string[] = [];
  for (const [name, raw] of Object.entries(document.services)) {
    const where = `${file}, service ${name}`;
    if (!SERVICE_NAME_PATTERN.test(name)) {
      throw new DeployError(`${file}: service name ${name} is not valid.`);
    }
    if (!isMapping(raw)) throw new DeployError(`${where} must be a mapping.`);
    if (isActive(raw.profiles)) {
      // Docker Compose does not start services with profiles by default either.
      skipped.push(name);
      continue;
    }
    for (const [key, reason] of Object.entries(REFUSED_SERVICE_KEYS)) {
      if (isActive(raw[key])) {
        throw new DeployError(`${where} ${reason} (${key}), which the platform does not allow.`);
      }
    }
    const ignored = Object.keys(raw).filter(
      (key) =>
        !HANDLED_SERVICE_KEYS.has(key) &&
        !QUIET_SERVICE_KEYS.has(key) &&
        !(key in REFUSED_SERVICE_KEYS) &&
        !key.startsWith("x-"),
    );
    if (ignored.length) warnings.push(`service ${name}: ignoring ${ignored.join(", ")}`);

    const service = interpolateAll(raw, vars, where) as Mapping;
    services.push(parseService(name, service, { where, directory, vars, options, warnings }));
  }

  if (skipped.length) {
    warnings.push(`skipping services with profiles: ${skipped.join(", ")}`);
  }
  if (services.length === 0) throw new DeployError(`${file} has no services to start.`);
  const max = options.maxServices ?? DEFAULT_MAX_COMPOSE_SERVICES;
  if (services.length > max) {
    throw new DeployError(
      `${file} has ${services.length} services; the platform runs at most ${max} per project.`,
    );
  }

  return { services: startOrder(services, file), warnings };
}

function parseService(
  name: string,
  service: Mapping,
  context: {
    where: string;
    directory: string;
    vars: Record<string, string>;
    options: ParseComposeOptions;
    warnings: string[];
  },
): ParsedService {
  const { where, directory, vars, options, warnings } = context;

  // Image or build.
  let build: ServiceBuild | null = null;
  let image: string | null = null;
  if (service.build !== undefined && service.build !== null) {
    const spec = isMapping(service.build) ? service.build : { context: service.build };
    if (spec.dockerfile_inline !== undefined) {
      throw new DeployError(`${where}: dockerfile_inline is not supported.`);
    }
    const contextText = String(spec.context ?? ".");
    if (/^[a-z]+:\/\/|^git@/i.test(contextText)) {
      throw new DeployError(`${where}: the build context must be a folder in the repository.`);
    }
    const buildContext = insideRepo(posix.join(directory, contextText));
    if (!buildContext) {
      throw new DeployError(
        `${where}: the build context ${contextText} is outside the repository.`,
      );
    }
    const dockerfile = insideRepo(String(spec.dockerfile ?? "Dockerfile"));
    if (!dockerfile || dockerfile === ".") {
      throw new DeployError(`${where}: the Dockerfile must be inside the build context.`);
    }
    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(stringMap(spec.args, `${where}: build.args`))) {
      const resolved = value ?? vars[key];
      if (resolved !== undefined) args[key] = resolved;
    }
    build = {
      context: buildContext,
      dockerfile,
      args,
      target: spec.target ? String(spec.target) : null,
    };
  } else if (typeof service.image === "string" && service.image.trim()) {
    const reference = service.image.trim();
    if (!IMAGE_REFERENCE_PATTERN.test(reference)) {
      throw new DeployError(`${where}: ${reference} is not a valid image reference.`);
    }
    image = normalizeImageReference(reference);
  } else {
    throw new DeployError(`${where} needs an image or a build section.`);
  }

  // Environment: env_file first, then environment, as in Docker Compose.
  const env: Record<string, string> = {};
  const envFiles =
    service.env_file === undefined || service.env_file === null
      ? []
      : Array.isArray(service.env_file)
        ? service.env_file
        : [service.env_file];
  for (const entry of envFiles) {
    const path = String(isMapping(entry) ? entry.path : entry);
    const required = isMapping(entry) ? entry.required !== false : true;
    const repoPath = insideRepo(posix.join(directory, path));
    if (!repoPath) throw new DeployError(`${where}: env_file ${path} is outside the repository.`);
    const content = options.readFile(repoPath);
    if (content === null) {
      if (required) throw new DeployError(`${where}: env_file ${path} does not exist.`);
      continue;
    }
    Object.assign(env, parseEnvFile(content));
  }
  for (const [key, value] of Object.entries(
    stringMap(service.environment, `${where}: environment`),
  )) {
    // A bare name takes its value from the project's variables, like from the shell.
    const resolved = value ?? vars[key];
    if (resolved !== undefined) env[key] = resolved;
  }

  // Volumes: named volumes are kept; repository folders are skipped (the image
  // already contains the code); host paths are refused.
  const volumes: VolumeMount[] = [];
  const tmpVolumes: string[] = [];
  const copies: Array<{ source: string; target: string }> = [];
  const rawVolumes = Array.isArray(service.volumes) ? service.volumes : [];
  for (const entry of rawVolumes) {
    let type: string;
    let source: string | null;
    let target: string;
    let readOnly = false;
    if (isMapping(entry)) {
      type = String(entry.type ?? "volume");
      source = entry.source ? String(entry.source) : null;
      target = String(entry.target ?? "");
      readOnly = entry.read_only === true;
    } else {
      const parts = String(entry).split(":");
      if (parts.length === 1) {
        type = "volume";
        source = null;
        target = parts[0]!;
      } else {
        source = parts[0]!;
        target = parts[1]!;
        readOnly = (parts[2] ?? "").split(",").includes("ro");
        type = /^[./~]/.test(source) ? "bind" : "volume";
      }
    }
    if (!target.startsWith("/")) {
      throw new DeployError(`${where}: volume target ${target} must be an absolute path.`);
    }
    if (type === "bind") {
      if (source && (source.startsWith(".") || !/^[/~]/.test(source))) {
        const repoPath = insideRepo(posix.join(directory, source));
        if (!repoPath) {
          throw new DeployError(`${where}: the folder mount ${source} is outside the repository.`);
        }
        copies.push({ source: repoPath, target });
        continue;
      }
      throw new DeployError(
        `${where} mounts ${source ?? "a host path"} from the host, which the platform does not allow. Use a named volume.`,
      );
    }
    if (type === "tmpfs") {
      tmpVolumes.push(target);
      continue;
    }
    if (type !== "volume") {
      throw new DeployError(`${where}: ${type} mounts are not supported.`);
    }
    if (source === null) {
      tmpVolumes.push(target);
    } else {
      if (!VOLUME_NAME_PATTERN.test(source)) {
        throw new DeployError(`${where}: volume name ${source} is not valid.`);
      }
      volumes.push({ name: source, target, readOnly });
    }
  }

  // Ports.
  const ports = Array.isArray(service.ports) ? service.ports : [];
  const expose = Array.isArray(service.expose) ? service.expose : [];
  const port =
    ports.map(containerPortOf).find((value) => value !== null) ??
    expose.map(toPort).find((value) => value !== null) ??
    null;

  const dependsOn = Array.isArray(service.depends_on)
    ? service.depends_on.map(String)
    : isMapping(service.depends_on)
      ? Object.keys(service.depends_on)
      : [];

  return {
    name,
    image,
    build,
    publishes: ports.length > 0,
    port,
    command: toCommand(service.command),
    entrypoint: toCommand(service.entrypoint),
    env,
    volumes,
    tmpVolumes,
    copies,
    workingDir: service.working_dir ? String(service.working_dir) : null,
    user: service.user !== undefined && service.user !== null ? String(service.user) : null,
    restart: restartPolicy(service.restart),
    dependsOn,
  };
}

/** Dependencies first; fails on unknown dependencies and cycles. */
function startOrder(services: ParsedService[], file: string): ParsedService[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  const ordered: ParsedService[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (service: ParsedService, chain: string[]) => {
    const current = state.get(service.name);
    if (current === "done") return;
    if (current === "visiting") {
      throw new DeployError(
        `${file}: the services depend on each other in a circle (${[...chain, service.name].join(" → ")}).`,
      );
    }
    state.set(service.name, "visiting");
    for (const dependency of service.dependsOn) {
      const target = byName.get(dependency);
      if (!target) {
        throw new DeployError(
          `${file}: service ${service.name} depends on ${dependency}, which is not started (missing, or it has a profile).`,
        );
      }
      visit(target, [...chain, service.name]);
    }
    state.set(service.name, "done");
    ordered.push(service);
  };

  for (const service of services) visit(service, []);
  return ordered;
}

/**
 * The service that gets the project's URL: the one the user chose, else the
 * only service that publishes a port, else the only service.
 */
export function choosePublicService(
  parsed: ParsedCompose,
  file: string,
  requested?: string,
): ParsedService {
  const names = parsed.services.map((service) => service.name);
  if (requested) {
    const chosen = parsed.services.find((service) => service.name === requested);
    if (!chosen) {
      throw new DeployError(
        `${file} has no service named ${requested}. Its services are: ${names.join(", ")}.`,
      );
    }
    return chosen;
  }
  if (parsed.services.length === 1) return parsed.services[0]!;
  const publishing = parsed.services.filter((service) => service.publishes);
  if (publishing.length === 1) return publishing[0]!;
  if (publishing.length === 0) {
    throw new DeployError(
      `None of the services in ${file} publishes a port, so it is unclear which one gets the URL. Choose one with the Compose service setting (services: ${names.join(", ")}).`,
    );
  }
  throw new DeployError(
    `Several services in ${file} publish ports: ${publishing.map((service) => service.name).join(", ")}. Choose the one that gets the URL with the Compose service setting and deploy again.`,
  );
}

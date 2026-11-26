"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  normalizeRepoUrl,
  projectNameFromRepo,
  type CreateProjectRequest,
  type ProjectView,
} from "@cloud-platform/contracts";
import { apiBaseUrl, createProject, describeSource, isSettling, listProjects } from "@/lib/api";
import { StatusPill } from "./status-pill";

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 10_000;

/** Parse "KEY=value" lines; blank lines and # comments are ignored. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) throw new Error(`Environment line "${line}" must look like KEY=value.`);
    env[line.slice(0, equals).trim()] = line.slice(equals + 1);
  }
  return env;
}

type Mode = "repo" | "image";

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("repo");
  const [repoUrl, setRepoUrl] = useState("");
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [dockerfilePath, setDockerfilePath] = useState("");
  const [port, setPort] = useState("");
  const [healthPath, setHealthPath] = useState("/");
  const [envText, setEnvText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load projects.");
    }
  }, []);

  const settling = projects?.some((project) => isSettling(project.status)) ?? false;

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, settling ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, settling]);

  const validRepo = normalizeRepoUrl(repoUrl);
  const suggestedName = mode === "repo" && validRepo ? projectNameFromRepo(validRepo) : "";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const request: CreateProjectRequest = {
        ...(name.trim() ? { name: name.trim() } : {}),
        source:
          mode === "repo"
            ? {
                type: "repo",
                repoUrl: repoUrl.trim(),
                ...(branch.trim() ? { branch: branch.trim() } : {}),
                ...(dockerfilePath.trim() ? { dockerfilePath: dockerfilePath.trim() } : {}),
              }
            : { type: "image", image: image.trim() },
        ...(port.trim() ? { containerPort: Number(port) } : {}),
        healthCheckPath: healthPath.trim() || "/",
        env: parseEnv(envText),
      };
      const { project } = await createProject(request);
      router.push(`/projects/${project.id}`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not create the project.");
      setSubmitting(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cloud Deploy</p>
        <h1>Paste a repo, get a URL.</h1>
        <p className="intro">
          Point the platform at a public GitHub repository. It finds the Dockerfile, builds it, runs
          it and hands you a link. No configuration needed.
        </p>

        <form className="card form" onSubmit={onSubmit}>
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "repo"}
              className={mode === "repo" ? "tab active" : "tab"}
              onClick={() => setMode("repo")}
            >
              GitHub repository
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "image"}
              className={mode === "image" ? "tab active" : "tab"}
              onClick={() => setMode("image")}
            >
              Docker image
            </button>
          </div>

          {mode === "repo" ? (
            <label>
              Repository URL
              <input
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                required
                autoFocus
                className="big-input"
              />
            </label>
          ) : (
            <div className="grid">
              <label>
                Docker image
                <input
                  value={image}
                  onChange={(event) => setImage(event.target.value)}
                  placeholder="nginx:alpine"
                  required
                />
              </label>
              <label>
                Container port
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  placeholder="80"
                  required
                />
              </label>
            </div>
          )}

          <details className="advanced" open={mode === "image"}>
            <summary>{mode === "repo" ? "Advanced (all optional)" : "More options"}</summary>
            <div className="grid">
              <label>
                Project name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value.toLowerCase())}
                  placeholder={suggestedName || "my-app"}
                  required={mode === "image"}
                  pattern="[a-z][a-z0-9\-]{1,28}[a-z0-9]"
                  title="3-30 characters: lowercase letters, digits and hyphens, starting with a letter"
                />
              </label>
              {mode === "repo" && (
                <>
                  <label>
                    Branch
                    <input
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                      placeholder="default branch"
                    />
                  </label>
                  <label>
                    Dockerfile path
                    <input
                      value={dockerfilePath}
                      onChange={(event) => setDockerfilePath(event.target.value)}
                      placeholder="found automatically"
                    />
                  </label>
                  <label>
                    Container port
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                      placeholder="from EXPOSE"
                    />
                  </label>
                </>
              )}
              <label>
                Health check path
                <input
                  value={healthPath}
                  onChange={(event) => setHealthPath(event.target.value)}
                  placeholder="/"
                />
              </label>
            </div>
            <label>
              Environment variables <span className="hint">(one KEY=value per line)</span>
              <textarea
                rows={3}
                value={envText}
                onChange={(event) => setEnvText(event.target.value)}
                placeholder={"GREETING=hello\nLOG_LEVEL=info"}
              />
            </label>
            <p className="muted">
              Environment values are visible in the dashboard; don&apos;t put secrets here. The app
              also receives <code>PORT</code>.
            </p>
          </details>

          <div className="form-footer">
            <span>
              {mode === "repo" && suggestedName && !name
                ? `Will be deployed as "${suggestedName}".`
                : ""}
            </span>
            <button type="submit" disabled={submitting}>
              {submitting ? "Starting…" : "Deploy"}
            </button>
          </div>
          {formError && <p className="error">{formError}</p>}
        </form>

        <div className="section-heading">
          <h2>Projects</h2>
          {projects && <span className="muted">{projects.length} total</span>}
        </div>

        {loadError && <p className="error">{loadError}</p>}
        {projects?.length === 0 && (
          <p className="muted empty">No projects yet. Paste a repository above.</p>
        )}

        <ul className="project-list">
          {projects?.map((project) => (
            <li key={project.id} className="card project">
              <div className="project-main">
                <Link href={`/projects/${project.id}`} className="project-name">
                  {project.name}
                </Link>
                <span className="muted mono">
                  {project.source.type === "repo" ? "⎇ " : "◫ "}
                  {describeSource(project.source)}
                </span>
              </div>
              <div className="project-side">
                <StatusPill status={project.status} />
                {project.liveDeployment ? (
                  <a href={project.url} target="_blank" rel="noreferrer" className="url">
                    {project.url.replace(/^https?:\/\//, "")} ↗
                  </a>
                ) : (
                  <span className="muted mono">{project.url.replace(/^https?:\/\//, "")}</span>
                )}
              </div>
              {project.status === "failed" && project.latestDeployment?.failureReason && (
                <p className="error project-error">{project.latestDeployment.failureReason}</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <footer>API at {apiBaseUrl || "this site (same origin)"}</footer>
    </main>
  );
}

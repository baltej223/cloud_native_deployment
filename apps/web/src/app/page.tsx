"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectView } from "@cloud-platform/contracts";
import { apiBaseUrl, createProject, isSettling, listProjects } from "@/lib/api";
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

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [port, setPort] = useState("80");
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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await createProject({
        name: name.trim(),
        source: { type: "image", image: image.trim() },
        containerPort: Number(port),
        healthCheckPath: healthPath.trim() || "/",
        env: parseEnv(envText),
      });
      setName("");
      setImage("");
      setEnvText("");
      await refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not create the project.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cloud Deploy</p>
        <h1>Ship a container, get a URL.</h1>
        <p className="intro">
          Give the platform a Docker image and the port it listens on. It pulls the image, runs it,
          checks that it answers, and hands you a link.
        </p>

        <form className="card form" onSubmit={onSubmit}>
          <div className="grid">
            <label>
              Project name
              <input
                value={name}
                onChange={(event) => setName(event.target.value.toLowerCase())}
                placeholder="hello-nginx"
                required
                pattern="[a-z][a-z0-9\-]{1,28}[a-z0-9]"
                title="3-30 characters: lowercase letters, digits and hyphens, starting with a letter"
              />
            </label>
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
                required
              />
            </label>
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
            Environment variables <span className="hint">(optional, one KEY=value per line)</span>
            <textarea
              rows={3}
              value={envText}
              onChange={(event) => setEnvText(event.target.value)}
              placeholder={"GREETING=hello\nLOG_LEVEL=info"}
            />
          </label>
          <div className="form-footer">
            <span>
              Environment values are visible in the dashboard; don&apos;t put secrets here.
            </span>
            <button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Deploy"}
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
          <p className="muted empty">No projects yet. Deploy your first image above.</p>
        )}

        <ul className="project-list">
          {projects?.map((project) => (
            <li key={project.id} className="card project">
              <div className="project-main">
                <Link href={`/projects/${project.id}`} className="project-name">
                  {project.name}
                </Link>
                <span className="muted mono">{project.source.image}</span>
              </div>
              <div className="project-side">
                <StatusPill status={project.status} />
                {project.status === "live" ? (
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

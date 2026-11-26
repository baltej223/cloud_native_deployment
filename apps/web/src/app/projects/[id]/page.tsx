"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { ProjectView } from "@cloud-platform/contracts";
import { deleteProject, getProject, isSettling } from "@/lib/api";
import { StatusPill } from "../../status-pill";

const POLL_MS = 2_000;

function formatTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const seconds = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProject(await getProject(id));
      setError(null);
    } catch (refreshError) {
      const message =
        refreshError instanceof Error ? refreshError.message : "Could not load the project.";
      // Once a deleted project's record is gone, go back to the list.
      if (deleting && /No project exists/.test(message)) {
        router.push("/");
        return;
      }
      setError(message);
    }
  }, [id, deleting, router]);

  const settling = project ? isSettling(project.status) : true;

  useEffect(() => {
    void refresh();
    if (!settling) return;
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, settling]);

  async function onDelete() {
    setDeleting(true);
    try {
      await deleteProject(id);
      await refresh();
    } catch (deleteError) {
      setDeleting(false);
      setError(
        deleteError instanceof Error ? deleteError.message : "Could not delete the project.",
      );
    }
  }

  const deployment = project?.latestDeployment;
  const envEntries = project ? Object.entries(project.env) : [];

  return (
    <main className="shell">
      <section className="hero">
        <Link href="/" className="back">
          ← All projects
        </Link>

        {error && <p className="error">{error}</p>}
        {!project && !error && <p className="muted">Loading…</p>}

        {project && (
          <>
            <div className="detail-heading">
              <h1>{project.name}</h1>
              <StatusPill status={project.status} />
            </div>

            <div className="card detail">
              <p className="eyebrow">URL</p>
              {project.status === "live" ? (
                <a href={project.url} target="_blank" rel="noreferrer" className="big-url">
                  {project.url} ↗
                </a>
              ) : (
                <p className="big-url muted">{project.url}</p>
              )}
              {project.status === "deploying" && (
                <p className="muted">
                  Starting the container and waiting for it to answer on port{" "}
                  {project.containerPort}…
                </p>
              )}
              {project.status === "failed" && deployment?.failureReason && (
                <p className="error">{deployment.failureReason}</p>
              )}
            </div>

            <div className="card detail">
              <dl>
                <dt>Image</dt>
                <dd className="mono">{deployment?.imageRef ?? project.source.image}</dd>
                <dt>Container port</dt>
                <dd>{project.containerPort}</dd>
                <dt>Health check</dt>
                <dd className="mono">{project.healthCheckPath}</dd>
                <dt>Created</dt>
                <dd>{formatTime(project.createdAt)}</dd>
                {deployment && (
                  <>
                    <dt>Deployment</dt>
                    <dd className="mono">{deployment.id}</dd>
                    <dt>Started</dt>
                    <dd>{formatTime(deployment.startedAt)}</dd>
                    <dt>Finished</dt>
                    <dd>
                      {formatTime(deployment.finishedAt)}
                      {duration(deployment.startedAt, deployment.finishedAt) &&
                        ` (${duration(deployment.startedAt, deployment.finishedAt)})`}
                    </dd>
                  </>
                )}
                <dt>Environment</dt>
                <dd>
                  {envEntries.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    <ul className="env">
                      {envEntries.map(([key, value]) => (
                        <li key={key} className="mono">
                          {key}={value}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </dl>
            </div>

            {project.status !== "deleting" && (
              <div className="danger">
                {confirmDelete ? (
                  <>
                    <span>Remove the app and free its URL?</span>
                    <button className="button-danger" onClick={onDelete} disabled={deleting}>
                      Yes, delete
                    </button>
                    <button className="button-quiet" onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="button-quiet" onClick={() => setConfirmDelete(true)}>
                    Delete project
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

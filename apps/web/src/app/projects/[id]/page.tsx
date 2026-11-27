"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { BuildLogResponse, DeploymentView, ProjectView } from "@cloud-platform/contracts";
import {
  deleteProject,
  describeSource,
  getBuildLog,
  getProject,
  isSettling,
  listDeployments,
  redeployProject,
  rollbackProject,
  startProject,
  stopProject,
} from "@/lib/api";
import { StatusPill } from "../../status-pill";
import { RuntimeLogs } from "./runtime-logs";
import { SettingsForm } from "./settings-form";

const POLL_MS = 2_000;

function formatTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const seconds = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<ProjectView | null>(null);
  const [deployments, setDeployments] = useState<DeploymentView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [buildLog, setBuildLog] = useState<BuildLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [latestProject, history] = await Promise.all([getProject(id), listDeployments(id)]);
      setProject(latestProject);
      setDeployments(history);
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

  // The build log shown: the one picked in the history, or the latest deployment's.
  const shownDeploymentId = selected ?? project?.latestDeployment?.id ?? null;
  const shownDeployment = deployments.find((deployment) => deployment.id === shownDeploymentId);
  const logIsLive = shownDeployment ? isSettling(shownDeployment.status) : false;
  const isRepo = project?.source.type === "repo";

  useEffect(() => {
    if (!shownDeploymentId || !isRepo) return;
    let cancelled = false;
    const load = async () => {
      try {
        const log = await getBuildLog(shownDeploymentId);
        if (!cancelled) setBuildLog(log);
      } catch {
        // The log is optional; status polling reports real errors.
      }
    };
    void load();
    if (!logIsLive) return () => void (cancelled = true);
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [shownDeploymentId, logIsLive, isRepo]);

  // Keep the newest build output in view.
  useEffect(() => {
    if (logRef.current && logIsLive) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [buildLog, logIsLive]);

  /** Run an action, then show its effect (or its error). */
  async function act(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const onRedeploy = () =>
    act(async () => {
      await redeployProject(id);
      setSelected(null);
    }, "Could not start a deployment.");

  const onRollback = (deploymentId: string) =>
    act(async () => {
      await rollbackProject(id, deploymentId);
      setSelected(null);
    }, "Could not roll back.");

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

  const latest = project?.latestDeployment;
  const live = project?.liveDeployment;
  const envEntries = project ? Object.entries(project.env) : [];
  const inProgress = latest ? isSettling(latest.status) : false;
  const stopped = project?.status === "stopped";

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
              {live && !stopped ? (
                <a href={project.url} target="_blank" rel="noreferrer" className="big-url">
                  {project.url} ↗
                </a>
              ) : (
                <p className="big-url muted">{project.url}</p>
              )}
              {latest?.status === "building" && (
                <p className="muted">Building the image from the repository…</p>
              )}
              {latest?.status === "deploying" && (
                <p className="muted">
                  Starting the container and waiting for it to answer on port{" "}
                  {latest.containerPort ?? project.containerPort}…
                </p>
              )}
              {latest?.status === "failed" && latest.failureReason && (
                <p className="error">{latest.failureReason}</p>
              )}
              {live && latest && live.id !== latest.id && (
                <p className="muted">
                  Still serving the previous version (commit {shortSha(live.commitSha)}, deployed{" "}
                  {formatTime(live.finishedAt)}).
                </p>
              )}
              {stopped && (
                <p className="muted">
                  {project.stopReason === "idle"
                    ? `Stopped automatically: no traffic since ${formatTime(project.lastActiveAt)}.`
                    : "Stopped. Its containers and data are kept."}{" "}
                  Start it to serve the URL again.
                </p>
              )}
              {project.status !== "deleting" && (
                <div className="actions">
                  {stopped ? (
                    <button
                      onClick={() => act(() => startProject(id), "Could not start the app.")}
                      disabled={busy}
                    >
                      Start
                    </button>
                  ) : (
                    <button onClick={onRedeploy} disabled={busy || inProgress}>
                      {inProgress
                        ? "Deploying…"
                        : isRepo
                          ? "Redeploy latest commit"
                          : "Redeploy (pull image again)"}
                    </button>
                  )}
                  {live && !stopped && (
                    <button
                      className="button-quiet"
                      onClick={() => act(() => stopProject(id), "Could not stop the app.")}
                      disabled={busy || inProgress}
                    >
                      Stop
                    </button>
                  )}
                  <button
                    className="button-quiet"
                    onClick={() => setEditing((value) => !value)}
                    disabled={busy}
                  >
                    Edit settings
                  </button>
                </div>
              )}
            </div>

            {editing && project.status !== "deleting" && (
              <div className="card detail">
                <p className="eyebrow">Settings</p>
                <p className="muted">Changes apply to the next deployment.</p>
                <SettingsForm
                  project={project}
                  onCancel={() => setEditing(false)}
                  onSaved={(saved, redeploy) => {
                    setProject(saved);
                    setEditing(false);
                    if (redeploy) void onRedeploy();
                  }}
                />
              </div>
            )}

            <div className="card detail">
              <dl>
                <dt>Source</dt>
                <dd className="mono">
                  {project.source.type === "repo" ? (
                    <a href={project.source.repoUrl} target="_blank" rel="noreferrer">
                      {describeSource(project.source)}
                    </a>
                  ) : (
                    describeSource(project.source)
                  )}
                </dd>
                {isRepo && (
                  <>
                    {latest?.compose ? (
                      <>
                        <dt>Compose file</dt>
                        <dd className="mono">{latest.compose.file}</dd>
                        <dt>Services</dt>
                        <dd className="mono">
                          {latest.compose.services
                            .map((name) =>
                              name === latest.compose!.publicService ? `${name} (URL)` : name,
                            )
                            .join(", ")}
                        </dd>
                      </>
                    ) : (
                      <>
                        <dt>Dockerfile</dt>
                        <dd className="mono">
                          {latest?.dockerfilePath ??
                            (project.source.type === "repo" && project.source.dockerfilePath) ??
                            "compose file or found automatically"}
                        </dd>
                      </>
                    )}
                    <dt>Commit</dt>
                    <dd className="mono">
                      {shortSha(live?.commitSha ?? latest?.commitSha ?? null)}
                    </dd>
                  </>
                )}
                <dt>Container port</dt>
                <dd>
                  {latest?.containerPort ?? project.containerPort ?? "from EXPOSE"}
                  {project.containerPort === null && latest?.containerPort
                    ? latest.compose
                      ? " (from the compose file)"
                      : " (from EXPOSE)"
                    : ""}
                </dd>
                <dt>Health check</dt>
                <dd className="mono">{project.healthCheckPath}</dd>
                <dt>Environment</dt>
                <dd>
                  {envEntries.length === 0 ? (
                    <span className="muted">none (PORT is set automatically)</span>
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

            {live && (
              <RuntimeLogs projectId={id} running={!stopped && project.status !== "deleting"} />
            )}

            {isRepo && shownDeployment && (
              <div className="card detail">
                <div className="log-heading">
                  <p className="eyebrow">Build log</p>
                  <span className="muted">
                    {shortSha(shownDeployment.commitSha)} · {formatTime(shownDeployment.createdAt)}
                  </span>
                </div>
                <pre className="log" ref={logRef}>
                  {buildLog?.deploymentId === shownDeploymentId && buildLog.log
                    ? buildLog.log
                    : shownDeployment.status === "pending"
                      ? "Waiting for the build to start…"
                      : "No build output."}
                </pre>
              </div>
            )}

            <div className="card detail">
              <p className="eyebrow">Deployments</p>
              <table className="history">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Status</th>
                    {isRepo && <th>Commit</th>}
                    <th>Took</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {deployments.map((deployment) => (
                    <tr
                      key={deployment.id}
                      className={deployment.id === shownDeploymentId ? "selected" : undefined}
                    >
                      <td>{formatTime(deployment.createdAt)}</td>
                      <td>
                        <StatusPill status={deployment.status} />
                      </td>
                      {isRepo && <td className="mono">{shortSha(deployment.commitSha)}</td>}
                      <td>
                        {duration(deployment.createdAt, deployment.finishedAt) ?? "—"}
                        {deployment.rollbackOf && <span className="muted"> · rollback</span>}
                      </td>
                      <td>
                        {isRepo && !deployment.rollbackOf && (
                          <button className="link" onClick={() => setSelected(deployment.id)}>
                            View log
                          </button>
                        )}
                        {deployment.status === "superseded" && deployment.imageRef && (
                          <button
                            className="link"
                            onClick={() => onRollback(deployment.id)}
                            disabled={busy || inProgress}
                          >
                            Roll back to this
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

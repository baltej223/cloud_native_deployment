"use client";

import { useState } from "react";
import type { ProjectView, UpdateProjectRequest } from "@cloud-platform/contracts";
import { updateProject } from "@/lib/api";

/** "KEY=value" lines to an object; blank lines and # comments are skipped. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) throw new Error(`"${line}" is not KEY=value.`);
    env[line.slice(0, equals).trim()] = line.slice(equals + 1);
  }
  return env;
}

/** Edit a project's settings. They apply to the next deployment. */
export function SettingsForm({
  project,
  onSaved,
  onCancel,
}: {
  project: ProjectView;
  onSaved: (project: ProjectView, redeploy: boolean) => void;
  onCancel: () => void;
}) {
  const repo = project.source.type === "repo" ? project.source : null;
  const [containerPort, setContainerPort] = useState(
    project.containerPort === null ? "" : String(project.containerPort),
  );
  const [healthCheckPath, setHealthCheckPath] = useState(project.healthCheckPath);
  const [env, setEnv] = useState(
    Object.entries(project.env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  const [branch, setBranch] = useState(repo?.branch ?? "");
  const [dockerfilePath, setDockerfilePath] = useState(repo?.dockerfilePath ?? "");
  const [composeService, setComposeService] = useState(repo?.composeService ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(redeploy: boolean) {
    setError(null);
    let changes: UpdateProjectRequest;
    try {
      const port = containerPort.trim();
      changes = {
        containerPort: port ? Number(port) : null,
        healthCheckPath: healthCheckPath.trim() || "/",
        env: parseEnv(env),
        ...(repo
          ? {
              branch: branch.trim() || null,
              dockerfilePath: dockerfilePath.trim() || null,
              composeService: composeService.trim() || null,
            }
          : {}),
      };
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Check the variables.");
      return;
    }
    setSaving(true);
    try {
      onSaved(await updateProject(project.id, changes), redeploy);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(false);
      }}
    >
      <div className="grid">
        <label>
          Container port <span className="hint">{repo ? "empty: detect" : "required"}</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={containerPort}
            onChange={(event) => setContainerPort(event.target.value)}
            placeholder={repo ? "from EXPOSE or the compose file" : "80"}
          />
        </label>
        <label>
          Health check path
          <input
            value={healthCheckPath}
            onChange={(event) => setHealthCheckPath(event.target.value)}
          />
        </label>
        {repo && (
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
                placeholder="found automatically; set to skip the compose file"
              />
            </label>
            <label>
              Compose service
              <input
                value={composeService}
                onChange={(event) => setComposeService(event.target.value)}
                placeholder="the one that publishes a port"
              />
            </label>
          </>
        )}
      </div>
      <label>
        Environment variables <span className="hint">one KEY=value per line</span>
        <textarea rows={5} value={env} onChange={(event) => setEnv(event.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" disabled={saving} onClick={() => void save(true)}>
          Save and redeploy
        </button>
        <button type="submit" className="button-quiet" disabled={saving}>
          Save for the next deployment
        </button>
        <button type="button" className="button-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

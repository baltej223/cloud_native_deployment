"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeLogResponse } from "@cloud-platform/contracts";
import { getRuntimeLogs } from "@/lib/api";

const REFRESH_MS = 5_000;

/** What the running app writes to stdout and stderr, refreshed every few seconds. */
export function RuntimeLogs({ projectId, running }: { projectId: string; running: boolean }) {
  const [service, setService] = useState<string | null>(null);
  const [logs, setLogs] = useState<RuntimeLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      setLogs(await getRuntimeLogs(projectId, service));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the logs.");
    }
  }, [projectId, service]);

  useEffect(() => {
    void load();
    if (!running) return;
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, running]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  return (
    <div className="card detail">
      <div className="log-heading">
        <p className="eyebrow">App logs</p>
        <span className="muted">
          {logs && logs.services.length > 0 && (
            <label className="inline">
              Service
              <select
                value={service ?? logs.service ?? ""}
                onChange={(event) => setService(event.target.value)}
              >
                {logs.services.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      <pre className="log" ref={ref}>
        {logs?.log ? logs.log : running ? "No output yet." : "The app is not running."}
      </pre>
    </div>
  );
}

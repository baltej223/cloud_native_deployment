import type { ProjectStatus } from "@cloud-platform/contracts";
import { isSettling, STATUS_LABELS } from "@/lib/api";

export function StatusPill({ status }: { status: ProjectStatus }) {
  return (
    <span className={`status status-${status}`}>
      {isSettling(status) && <span className="spinner" aria-hidden />}
      {STATUS_LABELS[status]}
    </span>
  );
}

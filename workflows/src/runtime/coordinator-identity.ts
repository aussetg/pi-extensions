import fs from "node:fs";

const RUN_ID = /^flow_[a-f0-9]{32}$/;

export function coordinatorUnitName(runId: string): string {
  if (!RUN_ID.test(runId)) throw new TypeError("Invalid coordinator run id");
  return `pi-workflow-coordinator-${runId.slice(5)}.service`;
}

export interface CoordinatorProcessIdentity {
  expectedUnit?: string;
  invocationId?: string;
  cgroupText: string;
}

/**
 * The transient systemd service is the ownership claim. The process refuses
 * to coordinate a run unless its environment and cgroup name the same exact
 * deterministic unit; no second ownership mechanism exists.
 */
export function assertCoordinatorProcessIdentity(
  runId: string,
  identity: CoordinatorProcessIdentity,
): string {
  const unit = coordinatorUnitName(runId);
  if (identity.expectedUnit !== unit) throw new Error(`Coordinator expected unit is not ${unit}`);
  if (!identity.invocationId || !/^[a-f0-9]{32}$/.test(identity.invocationId)) {
    throw new Error("Coordinator has no valid systemd invocation identity");
  }
  const cgroup = unifiedCgroup(identity.cgroupText);
  if (!cgroup.split("/").includes(unit)) {
    throw new Error(`Coordinator process is not running in ${unit}`);
  }
  return unit;
}

export async function assertCurrentCoordinatorProcessIdentity(runId: string): Promise<string> {
  const cgroupText = await fs.promises.readFile("/proc/self/cgroup", "utf8");
  return assertCoordinatorProcessIdentity(runId, {
    expectedUnit: process.env.PI_WORKFLOW_COORDINATOR_UNIT,
    invocationId: process.env.INVOCATION_ID,
    cgroupText,
  });
}

function unifiedCgroup(source: string): string {
  const records = source.split("\n").filter(Boolean);
  const match = records.map((record) => /^0::(.+)$/.exec(record)).find(Boolean);
  if (!match || !match[1]?.startsWith("/")) throw new Error("Coordinator has no unified cgroup v2 identity");
  return match[1];
}


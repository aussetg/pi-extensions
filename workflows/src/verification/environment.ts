import { normalizeCommandProfile, type CommandProfileSnapshot } from "../commands/profiles.js";
import type { HostCommandExecutorDescriptor } from "../commands/executor.js";
import { stableHash } from "../utils/hashes.js";
import type {
  VerificationCommandGate,
  VerificationCommandProfile,
  VerificationDiffPolicy,
  VerificationProfileSnapshot,
  VerificationReviewPolicy,
} from "./profiles.js";

export interface VerificationReviewerEnvironment {
  profileId: string;
  routeId: string;
  authorityHash: string;
}

/** The command profile actually executed for one verification gate. */
export function verificationCommandProfile(
  verificationProfileId: string,
  gate: "tests" | "diagnostics",
  command: VerificationCommandProfile,
): CommandProfileSnapshot {
  const definition = normalizeCommandProfile({
    name: `verify-${gate}-${command.id}`.slice(0, 64),
    description: `Pinned ${gate} gate from ${verificationProfileId}`,
    argv: command.argv,
    ...(command.env ? { env: command.env } : {}),
    timeoutMs: command.timeoutMs,
    outputLimitBytes: 8 * 1024 * 1024,
    effects: ["read-only"],
  });
  const hash = stableHash({ namespace: "builtin", definition });
  return {
    ...definition,
    id: `builtin:${definition.name}`,
    namespace: "builtin",
    path: `<builtin:verification:${verificationProfileId}:${gate}:${command.id}>`,
    hash,
  };
}

export function verificationCommandEnvironmentHash(
  profile: CommandProfileSnapshot,
  executor: HostCommandExecutorDescriptor,
): string {
  return stableHash({
    profileHash: profile.hash,
    executor: commandExecutorProtocol(executor),
  });
}

export function verificationNotApplicableEnvironmentHash(reason: string): string {
  return stableHash({ notApplicable: reason });
}

export function verificationDiffEnvironmentHash(policy: VerificationDiffPolicy): string {
  return stableHash({ implementation: "deterministic-diff", policy });
}

export function verificationContaminationEnvironmentHash(): string {
  return stableHash({ implementation: "candidate-contamination" });
}

export function verificationReviewerEnvironmentHash(
  reviewer: VerificationReviewerEnvironment,
): string {
  return stableHash({
    profileId: reviewer.profileId,
    routeId: reviewer.routeId,
    reviewerAuthorityHash: reviewer.authorityHash,
  });
}

/** Recompute the exact gate-environment binding without rerunning any gate. */
export function verificationGateEnvironmentHash(
  profile: VerificationProfileSnapshot,
  commandExecutor: HostCommandExecutorDescriptor,
  reviewer?: VerificationReviewerEnvironment,
): string {
  const gates = [
    {
      kind: "tests",
      environmentHash: commandGateEnvironmentHash(profile.id, "tests", profile.tests, commandExecutor),
    },
    {
      kind: "diagnostics",
      environmentHash: commandGateEnvironmentHash(profile.id, "diagnostics", profile.diagnostics, commandExecutor),
    },
    {
      kind: "diff-inspection",
      environmentHash: verificationDiffEnvironmentHash(profile.diffInspection),
    },
    {
      kind: "adversarial-review",
      environmentHash: reviewEnvironmentHash(profile.adversarialReview, reviewer),
    },
    {
      kind: "contamination",
      environmentHash: verificationContaminationEnvironmentHash(),
    },
  ];
  return stableHash(gates);
}

function commandGateEnvironmentHash(
  verificationProfileId: string,
  gate: "tests" | "diagnostics",
  configured: VerificationCommandGate,
  executor: HostCommandExecutorDescriptor,
): string {
  if (!Array.isArray(configured)) return verificationNotApplicableEnvironmentHash(configured.notApplicable);
  return stableHash(configured.map((command) => {
    const profile = verificationCommandProfile(verificationProfileId, gate, command);
    return {
      commandId: command.id,
      environmentHash: verificationCommandEnvironmentHash(profile, executor),
    };
  }));
}

function reviewEnvironmentHash(
  policy: VerificationReviewPolicy,
  reviewer: VerificationReviewerEnvironment | undefined,
): string {
  if ("notApplicable" in policy) {
    if (reviewer) throw new Error("A not-applicable verification review has reviewer authority");
    return verificationNotApplicableEnvironmentHash(policy.notApplicable);
  }
  if (!reviewer) throw new Error("Current adversarial reviewer authority is unavailable");
  return verificationReviewerEnvironmentHash(reviewer);
}

function commandExecutorProtocol(executor: HostCommandExecutorDescriptor): object {
  return {
    id: executor.id,
    sandbox: executor.sandbox,
  };
}

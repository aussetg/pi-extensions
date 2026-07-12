export function includeProjectWorkflowResources(ctx: unknown): boolean {
  const isProjectTrusted = (ctx as { isProjectTrusted?: unknown } | undefined)?.isProjectTrusted;
  if (typeof isProjectTrusted !== "function") return true;
  return isProjectTrusted.call(ctx) === true;
}

export function registryRefreshOptions(ctx: unknown): { includeProject: boolean } {
  return { includeProject: includeProjectWorkflowResources(ctx) };
}

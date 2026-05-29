import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_TOOL_NAME = "workflow";

export interface WorkflowActivation {
  enable(ctx?: any): boolean;
  disable(ctx?: any): boolean;
  toggle(ctx?: any): boolean;
  reset(ctx?: any): void;
  enforce(ctx?: any): void;
  report(ctx?: any): void;
  isActive(): boolean;
  isManuallyEnabled(): boolean;
  updateStatus(ctx?: any): void;
}

export function createWorkflowActivation(pi: ExtensionAPI): WorkflowActivation {
  let manuallyEnabled = false;

  const setActive = (active: boolean): boolean => {
    const current = safeActiveTools(pi);
    const hasWorkflow = current.includes(WORKFLOW_TOOL_NAME);
    if (active === hasWorkflow) return hasWorkflow;

    const next = active
      ? [...current, WORKFLOW_TOOL_NAME]
      : current.filter((name) => name !== WORKFLOW_TOOL_NAME);
    pi.setActiveTools(next);
    return active;
  };

  const updateStatus = (ctx?: any) => {
    const active = isWorkflowActive(pi);
    const color = active ? "accent" : "dim";
    const text = active ? "workflow:on" : "workflow:off";
    const styled = ctx?.ui?.theme?.fg ? ctx.ui.theme.fg(color, text) : text;
    ctx?.ui?.setStatus?.("workflow", styled);
  };

  const notify = (ctx: any, message: string, level: "info" | "warning" = "info") => {
    if (ctx?.hasUI) ctx.ui?.notify?.(message, level);
    else if (message) console.log(message);
  };

  return {
    enable(ctx?: any): boolean {
      manuallyEnabled = true;
      const active = setActive(true);
      updateStatus(ctx);
      notify(ctx, "Workflow tool enabled for the agent. Use /workflow disable to turn it off.");
      return active;
    },

    disable(ctx?: any): boolean {
      manuallyEnabled = false;
      const active = setActive(false);
      updateStatus(ctx);
      notify(ctx, "Workflow tool disabled. Manual /workflow run commands still work.");
      return active;
    },

    toggle(ctx?: any): boolean {
      return isWorkflowActive(pi) ? this.disable(ctx) : this.enable(ctx);
    },

    reset(ctx?: any): void {
      manuallyEnabled = false;
      setActive(false);
      updateStatus(ctx);
    },

    enforce(ctx?: any): void {
      if (!manuallyEnabled) setActive(false);
      updateStatus(ctx);
    },

    report(ctx?: any): void {
      updateStatus(ctx);
      const state = isWorkflowActive(pi) ? "active" : "inactive";
      notify(ctx, `Workflow tool is ${state}. It is off by default; use /workflow enable to let the agent call it.`);
    },

    isActive(): boolean {
      return isWorkflowActive(pi);
    },

    isManuallyEnabled(): boolean {
      return manuallyEnabled;
    },

    updateStatus,
  };
}

function safeActiveTools(pi: ExtensionAPI): string[] {
  try {
    return pi.getActiveTools?.() ?? [];
  } catch {
    return [];
  }
}

function isWorkflowActive(pi: ExtensionAPI): boolean {
  return safeActiveTools(pi).includes(WORKFLOW_TOOL_NAME);
}

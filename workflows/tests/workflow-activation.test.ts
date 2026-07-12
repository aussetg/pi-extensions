import { describe, expect, it } from "vitest";
import { createWorkflowActivation } from "../src/tool/workflow-activation.js";

describe("workflow activation", () => {
  it("is off by default and only enables on explicit command", () => {
    let activeTools = ["read", "workflow", "bash"];
    const statuses: Record<string, string | undefined> = {};
    const activation = createWorkflowActivation({
      getActiveTools: () => activeTools,
      setActiveTools: (next: string[]) => {
        activeTools = next;
      },
    } as any);
    const ctx = { ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: (key: string, value?: string) => { statuses[key] = value; } } };

    activation.reset(ctx);
    expect(activeTools).toEqual(["read", "bash"]);
    expect(statuses.workflow).toBe("workflow:off");

    activation.enable(ctx);
    expect(activeTools).toEqual(["read", "bash", "workflow"]);
    expect(statuses.workflow).toBe("workflow:on");

    activation.disable(ctx);
    expect(activeTools).toEqual(["read", "bash"]);
    expect(statuses.workflow).toBe("workflow:off");
  });
});

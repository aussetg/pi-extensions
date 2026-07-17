// Definition and deep-readonly checks for the workflow runtime v17 contract.
import { schema as s, workflow, type Infer } from "pi/workflows";

const Input = s.object({
  objective: s.string(),
  nested: s.object({ value: s.string() }),
  items: s.array(s.string()),
});
const Output = s.object({ ok: s.boolean() });

export const valid = workflow({
  title: "Contract",
  description: "One strict source of workflow metadata and schemas.",
  input: Input,
  output: Output,
  concurrency: 2,
  async run(_flow, input) {
    const objective: string = input.objective;
    return { ok: objective.length > 0 };
  },
});

workflow({
  // @ts-expect-error installed identity comes from namespace and filename
  name: "source-owned-name",
  description: "Invalid source metadata.",
  input: Input,
  output: Output,
  async run() { return { ok: true }; },
});

workflow({
  description: "Output must agree with its schema.",
  input: Input,
  output: Output,
  // @ts-expect-error run output is inferred from the declared output schema
  async run() { return { ok: "not boolean" }; },
});

export function readonlyInput(input: Infer<typeof Input>) {
  // @ts-expect-error schema-inferred object properties are deeply readonly
  input.nested.value = "changed";
  // @ts-expect-error schema-inferred arrays are readonly
  input.items.push("changed");
}

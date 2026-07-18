// Representative strict schema-facade inference fixture.
import { schema as s, type Infer } from "pi/workflows";

export const PointEvidence = s.object({
  id: s.id(),
  summary: s.string({ minLength: 1, maxLength: 2_000 }),
});

export const PointOutcome = s.object({
  outcome: s.enum(["completed", "skipped", "blocked", "replan", "failed"]),
  pointId: s.id(),
  summary: s.string({ minLength: 1, maxLength: 8_000 }),
  evidence: s.array(PointEvidence, { maxItems: 32 }),
  nextWork: s.array(s.string({ minLength: 1, maxLength: 2_000 }), { maxItems: 16 }),
  blocker: s.nullable(s.string({ minLength: 1, maxLength: 4_000 })),
});

export type PointOutcome = Infer<typeof PointOutcome>;

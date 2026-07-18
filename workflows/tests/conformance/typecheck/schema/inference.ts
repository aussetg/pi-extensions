import type { PointOutcome as Facade } from "./facade.js";

type ExpectedOutcome = "completed" | "skipped" | "blocked" | "replan" | "failed";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type FacadeOutcome = Assert<Equal<Facade["outcome"], ExpectedOutcome>>;
type FacadeEvidence = Assert<Facade["evidence"] extends readonly { readonly id: string }[] ? true : false>;

export type SchemaInferenceAssertions = FacadeOutcome | FacadeEvidence;

export class RunRevisionConflictError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`Run revision changed (expected ${expected}, got ${actual})`);
    this.name = "RunRevisionConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class RunDatabaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunDatabaseStateError";
  }
}

export class RunDatabaseAdmissionError extends Error {
  readonly guard: "operations" | "agent-launches";
  readonly admitted: number;
  readonly requested: number;
  readonly limit: number;

  constructor(
    guard: "operations" | "agent-launches",
    admitted: number,
    requested: number,
    limit: number,
  ) {
    super(
      guard === "operations"
        ? `Admitting ${requested} operations would exceed the host limit ${limit} (${admitted} already admitted)`
        : `Admitting ${requested} agents would exceed the launch limit ${limit} (${admitted} already admitted)`,
    );
    this.name = "RunDatabaseAdmissionError";
    this.guard = guard;
    this.admitted = admitted;
    this.requested = requested;
    this.limit = limit;
  }
}

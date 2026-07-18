import vm from "node:vm";

const SAFE_PATH_PATTERN = "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*//)(?!.*\\\\)[^\\u0000-\\u001f\\u007f]+$";

/** Build every v17 author-visible value from control-realm intrinsics. */
export function createWorkflowControlRealm(context, options) {
  const bootstrap = new vm.Script(`
    ((hostCall, hostSyncCall, metricCall, configuration) => {
      "use strict";
      const create = Object.create;
      const defineProperty = Object.defineProperty;
      const defineProperties = Object.defineProperties;
      const freeze = Object.freeze;
      const keys = Object.keys;
      const entries = Object.entries;
      const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
      const getPrototypeOf = Object.getPrototypeOf;
      const SafeError = Error;
      const SafeTypeError = TypeError;
      const schemas = new WeakMap();
      const sourceSiteRecords = new WeakMap();
      const sourceSites = new Map();
      const authorityRecords = new WeakMap();
      const remoteAuthorities = new Map();
      const descriptorValues = new Map();
      const forbiddenKeys = new Set(["constructor", "prototype", "__proto__"]);
      const resourceKey = "x-pi-workflow-resource";
      const safePathKey = "x-pi-workflow-safe-path";

      const plainRecord = (value, label) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeTypeError(label + " must be an object");
        const prototype = getPrototypeOf(value);
        if (prototype !== null && prototype !== Object.prototype) throw new SafeTypeError(label + " must be a plain object");
        const descriptors = getOwnPropertyDescriptors(value);
        for (const key of keys(descriptors)) {
          const descriptor = descriptors[key];
          if (forbiddenKeys.has(key) || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
            throw new SafeTypeError(label + "." + key + " must be an enumerable data property");
          }
        }
        return value;
      };
      const exactKeys = (value, allowed, required, label) => {
        plainRecord(value, label);
        for (const key of keys(value)) if (!allowed.includes(key)) throw new SafeTypeError(label + " contains unknown field " + key);
        for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new SafeTypeError(label + " requires " + key);
      };
      const finite = (value, label) => {
        if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new SafeTypeError(label + " must be finite");
        return value;
      };
      const safeInteger = (value, label, minimum = 0) => {
        if (!Number.isSafeInteger(value) || value < minimum) throw new SafeTypeError(label + " must be a safe integer ≥ " + minimum);
        return value;
      };
      const copyArray = values => {
        const result = [];
        for (let index = 0; index < values.length; index += 1) result.push(values[index]);
        return result;
      };
      const copyObject = inputEntries => {
        const result = create(null);
        for (let index = 0; index < inputEntries.length; index += 1) {
          const entry = inputEntries[index];
          if (forbiddenKeys.has(entry[0])) throw new SafeTypeError("Reserved workflow control property " + entry[0]);
          defineProperty(result, entry[0], {
            value: entry[1], enumerable: true, writable: true, configurable: true,
          });
        }
        return result;
      };
      const deepFreeze = (value, seen = new Set()) => {
        if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return value;
        seen.add(value);
        for (const key of keys(value)) deepFreeze(value[key], seen);
        return freeze(value);
      };
      const cloneJson = (value, label, seen = new Set()) => {
        if (value === null || typeof value === "boolean" || typeof value === "string") return value;
        if (typeof value === "number") return finite(value, label);
        if (!value || typeof value !== "object") throw new SafeTypeError(label + " must be JSON");
        if (seen.has(value)) throw new SafeTypeError(label + " may not be cyclic");
        seen.add(value);
        try {
          if (Array.isArray(value)) return value.map((entry, index) => cloneJson(entry, label + "[" + index + "]", seen));
          plainRecord(value, label);
          const result = create(null);
          for (const key of keys(value)) result[key] = cloneJson(value[key], label + "." + key, seen);
          return result;
        } finally {
          seen.delete(value);
        }
      };
      const stable = value => {
        const authority = value && typeof value === "object" ? authorityRecords.get(value) : undefined;
        if (authority) return stable({
          family: authority.family,
          id: authority.id,
          identity: authority.identity,
        });
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
        return "{" + keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
      };
      const same = (left, right) => stable(left) === stable(right);

      const schema = (value, optional = false) => {
        const result = deepFreeze(cloneJson(value, "workflow schema"));
        schemas.set(result, freeze({ optional }));
        return result;
      };
      const schemaRecord = (value, label, allowOptional = false) => {
        const record = value && typeof value === "object" ? schemas.get(value) : undefined;
        if (!record) throw new SafeTypeError(label + " must be a schema value");
        if (!allowOptional && record.optional) throw new SafeTypeError(label + " may not be optional");
        return record;
      };
      const optionsRecord = (value, allowed, label) => {
        if (value === undefined) return create(null);
        exactKeys(value, allowed, [], label);
        return value;
      };
      const numberSchema = (kind, value) => {
        const options = optionsRecord(value, ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"], "schema." + kind + " options");
        const result = { type: kind };
        for (const key of keys(options)) result[key] = finite(options[key], "schema." + kind + "." + key);
        return schema(result);
      };
      const rejectReservedSchemaKeys = value => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const child of value) rejectReservedSchemaKeys(child); return; }
        for (const [key, child] of entries(value)) {
          if (key.startsWith("x-pi-workflow-")) throw new SafeTypeError("schema.raw may not mint reserved authority field " + key);
          rejectReservedSchemaKeys(child);
        }
      };
      const schemaFacade = freeze({
        string: value => {
          const options = optionsRecord(value, ["minLength", "maxLength", "pattern", "format"], "schema.string options");
          const result = { type: "string" };
          if (options.minLength !== undefined) result.minLength = safeInteger(options.minLength, "schema.string.minLength");
          if (options.maxLength !== undefined) result.maxLength = safeInteger(options.maxLength, "schema.string.maxLength");
          if (options.pattern !== undefined) {
            if (typeof options.pattern !== "string" || options.pattern.length > 2000) throw new SafeTypeError("schema.string.pattern is invalid");
            new RegExp(options.pattern);
            result.pattern = options.pattern;
          }
          if (options.format !== undefined) {
            if (typeof options.format !== "string" || options.format.length > 128) throw new SafeTypeError("schema.string.format is invalid");
            result.format = options.format;
          }
          return schema(result);
        },
        number: value => numberSchema("number", value),
        integer: value => numberSchema("integer", value),
        boolean: () => schema({ type: "boolean" }),
        literal: value => {
          if (value !== null && typeof value !== "boolean" && typeof value !== "string" && typeof value !== "number") {
            throw new SafeTypeError("schema.literal requires a JSON primitive");
          }
          if (typeof value === "number") finite(value, "schema.literal value");
          return schema({ const: value });
        },
        enum: values => {
          if (!Array.isArray(values) || values.length < 1 || values.length > 256
            || values.some(value => typeof value !== "string") || new Set(values).size !== values.length) {
            throw new SafeTypeError("schema.enum requires 1–256 unique strings");
          }
          return schema({ type: "string", enum: copyArray(values) });
        },
        nullable: value => {
          schemaRecord(value, "schema.nullable value");
          return schema({ anyOf: [value, { type: "null" }] });
        },
        optional: value => {
          schemaRecord(value, "schema.optional value");
          return schema(value, true);
        },
        array: (value, rawOptions) => {
          schemaRecord(value, "schema.array items");
          const options = optionsRecord(rawOptions, ["minItems", "maxItems", "uniqueItems"], "schema.array options");
          const result = { type: "array", items: value };
          if (options.minItems !== undefined) result.minItems = safeInteger(options.minItems, "schema.array.minItems");
          if (options.maxItems !== undefined) result.maxItems = safeInteger(options.maxItems, "schema.array.maxItems");
          if (options.uniqueItems !== undefined) {
            if (typeof options.uniqueItems !== "boolean") throw new SafeTypeError("schema.array.uniqueItems must be boolean");
            result.uniqueItems = options.uniqueItems;
          }
          return schema(result);
        },
        object: properties => {
          plainRecord(properties, "schema.object properties");
          const resultProperties = create(null);
          const required = [];
          for (const name of keys(properties)) {
            const value = properties[name];
            const record = schemaRecord(value, "schema.object." + name, true);
            resultProperties[name] = value;
            if (!record.optional) required.push(name);
          }
          required.sort();
          return schema({
            type: "object", additionalProperties: false, properties: resultProperties,
            ...(required.length ? { required } : {}),
          });
        },
        union: members => {
          if (!Array.isArray(members) || members.length < 1) throw new SafeTypeError("schema.union requires a nonempty array");
          for (const member of members) schemaRecord(member, "schema.union member");
          return schema({ anyOf: copyArray(members) });
        },
        record: value => {
          schemaRecord(value, "schema.record values");
          return schema({ type: "object", additionalProperties: value });
        },
        id: () => schema({ type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
        safePath: () => schema({
          type: "string", minLength: 1, maxLength: 4096,
          pattern: ${JSON.stringify(SAFE_PATH_PATTERN)},
          [safePathKey]: true,
        }),
        json: () => schema({}),
        measurementProfile: () => schema({
          type: "string", pattern: "^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$",
          [resourceKey]: "measurement-profile",
        }),
        raw: value => {
          plainRecord(value, "schema.raw value");
          rejectReservedSchemaKeys(value);
          return schema(value);
        },
      });

      const expectedDescriptors = new Map();
      for (const descriptor of configuration.descriptors) {
        if (expectedDescriptors.has(descriptor.identity.sourceSite)) throw new SafeTypeError("Duplicate workflow descriptor source site");
        expectedDescriptors.set(descriptor.identity.sourceSite, descriptor);
      }
      const expectedOperations = new Map();
      for (const operation of configuration.operationSites) {
        if (expectedOperations.has(operation.sourceSite)) throw new SafeTypeError("Duplicate workflow operation source site");
        expectedOperations.set(operation.sourceSite, operation.method);
      }

      const sourceSite = id => {
        if (typeof id !== "string") throw new SafeTypeError("Workflow source site must be a string");
        const descriptor = expectedDescriptors.get(id);
        const method = expectedOperations.get(id);
        if (!descriptor && !method) throw new SafeTypeError("Unknown workflow source site " + id);
        let value = sourceSites.get(id);
        if (value) return value;
        value = freeze(create(null));
        const record = freeze(descriptor
          ? { sourceSite: id, role: "descriptor", kind: descriptor.identity.kind }
          : { sourceSite: id, role: "operation", method });
        sourceSites.set(id, value);
        sourceSiteRecords.set(value, record);
        return value;
      };
      const normalizeAgent = definition => {
        exactKeys(definition, ["profile", "output", "workspace", "network", "instructions", "title"], ["profile", "output"], "agent descriptor");
        schemaRecord(definition.output, "agent output");
        return {
          profile: definition.profile,
          output: definition.output,
          workspace: definition.workspace ?? "snapshot",
          network: definition.network ?? "none",
          ...(definition.instructions !== undefined ? { instructions: definition.instructions } : {}),
          ...(definition.title !== undefined ? { title: definition.title } : {}),
        };
      };
      const normalizeCommand = definition => {
        exactKeys(definition, ["profile", "output", "effect", "allowFailure", "title"], ["profile"], "command descriptor");
        return {
          profile: definition.profile,
          output: definition.output ?? "summary",
          effect: definition.effect ?? "read-only",
          allowFailure: definition.allowFailure ?? false,
          ...(definition.title !== undefined ? { title: definition.title } : {}),
        };
      };
      const descriptor = (kind, site, definition) => {
        const siteRecord = sourceSiteRecords.get(site);
        if (!siteRecord || siteRecord.role !== "descriptor" || siteRecord.kind !== kind) {
          throw new SafeTypeError("Workflow descriptor constructor has the wrong source site");
        }
        const expected = expectedDescriptors.get(siteRecord.sourceSite);
        const normalized = kind === "agent-task" ? normalizeAgent(definition) : normalizeCommand(definition);
        if (!same(normalized, expected.definition)) {
          throw new SafeTypeError("Workflow descriptor differs from its reviewed definition");
        }
        let value = descriptorValues.get(siteRecord.sourceSite);
        if (value) return value;
        value = freeze(create(null));
        authorityRecords.set(value, freeze({
          family: "descriptor", id: siteRecord.sourceSite, identity: expected.identity,
        }));
        descriptorValues.set(siteRecord.sourceSite, value);
        return value;
      };
      const language = freeze({
        agent: (site, definition) => descriptor("agent-task", site, definition),
        command: (site, definition) => descriptor("command-task", site, definition),
        schema: schemaFacade,
        workflow: definition => {
          exactKeys(definition, ["title", "description", "input", "output", "concurrency", "run"], ["description", "input", "output", "run"], "workflow definition");
          schemaRecord(definition.input, "workflow input");
          schemaRecord(definition.output, "workflow output");
          if (typeof definition.run !== "function") throw new SafeTypeError("Workflow definition run must be a function");
          const metadata = {
            ...(definition.title !== undefined ? { title: definition.title } : {}),
            description: definition.description,
            input: definition.input,
            output: definition.output,
            ...(definition.concurrency !== undefined ? { concurrency: definition.concurrency } : {}),
          };
          if (!same(metadata, configuration.metadata)) throw new SafeTypeError("Workflow definition differs from reviewed metadata");
          return deepFreeze(definition);
        },
      });

      const createMetricSetAuthority = (family, id, identity, fieldEntries) => {
        if (family !== "reference" || identity.kind !== "metric-set" || fieldEntries.length !== 0) {
          throw new SafeTypeError("Workflow metric-set transport is invalid");
        }
        const key = family + ":" + id;
        const existing = remoteAuthorities.get(key);
        if (existing) {
          const record = authorityRecords.get(existing);
          if (!same(record.identity, identity)) throw new SafeTypeError("Workflow metric-set identity changed");
          return existing;
        }
        const invoke = (method, args) => metricCall(id, method, args);
        const primary = create(null);
        defineProperty(primary, "reachedTarget", {
          value: () => invoke("reachedTarget", []), enumerable: true, writable: false, configurable: false,
        });
        freeze(primary);
        const value = create(null);
        defineProperties(value, {
          primary: { value: primary, enumerable: true, writable: false, configurable: false },
          policy: { value: () => invoke("policy", []), enumerable: true, writable: false, configurable: false },
          summary: { value: () => invoke("summary", []), enumerable: true, writable: false, configurable: false },
          evaluate: { value: measurement => invoke("evaluate", [measurement]), enumerable: true, writable: false, configurable: false },
        });
        freeze(value);
        authorityRecords.set(value, freeze({ family, id, identity, fields: freeze(create(null)) }));
        remoteAuthorities.set(key, value);
        return value;
      };
      const createRemoteAuthority = (family, id, identity, fieldEntries) => {
        if (family === "reference" && identity.kind === "metric-set") {
          return createMetricSetAuthority(family, id, identity, fieldEntries);
        }
        const key = family + ":" + id;
        const fieldShape = create(null);
        for (const entry of fieldEntries) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || forbiddenKeys.has(entry[0])) {
            throw new SafeTypeError("Workflow remote authority fields are invalid");
          }
          if (Object.prototype.hasOwnProperty.call(fieldShape, entry[0])) throw new SafeTypeError("Duplicate workflow authority field " + entry[0]);
          fieldShape[entry[0]] = deepFreeze(entry[1]);
        }
        const existing = remoteAuthorities.get(key);
        if (existing) {
          const record = authorityRecords.get(existing);
          if (!same(record.identity, identity) || !same(record.fields, fieldShape)) {
            throw new SafeTypeError("Workflow remote authority identity or public fields changed");
          }
          return existing;
        }
        const value = create(null);
        for (const name of keys(fieldShape)) {
          defineProperty(value, name, {
            value: fieldShape[name], enumerable: true, writable: false, configurable: false,
          });
        }
        freeze(value);
        authorityRecords.set(value, freeze({ family, id, identity, fields: freeze(fieldShape) }));
        remoteAuthorities.set(key, value);
        return value;
      };
      const createError = serialized => {
        const error = new SafeError(serialized.message);
        defineProperty(error, "name", { value: serialized.name, enumerable: false, writable: true, configurable: true });
        if (serialized.stack !== undefined) defineProperty(error, "stack", { value: serialized.stack, enumerable: false, writable: true, configurable: true });
        if (serialized.properties !== undefined) {
          for (const key of keys(serialized.properties)) defineProperty(error, key, {
            value: serialized.properties[key], enumerable: true, writable: true, configurable: true,
          });
        }
        if (serialized.hostErrorId !== undefined) defineProperty(error, "__flowHostErrorId", { value: serialized.hostErrorId });
        return error;
      };
      const createFlow = (snapshotPresent, snapshot) => {
        if (snapshotPresent) {
          const authority = authorityRecords.get(snapshot);
          if (!authority || authority.family !== "reference" || authority.identity.kind !== "launch-snapshot") {
            throw new SafeTypeError("Workflow snapshot authority is invalid");
          }
        }
        const flow = create(null);
        for (const method of configuration.asyncMethods) defineProperty(flow, method, {
          enumerable: true,
          value: async (site, ...args) => {
            const record = sourceSiteRecords.get(site);
            if (!record || record.role !== "operation" || record.method !== method) {
              throw new SafeTypeError("flow." + method + " has the wrong reviewed source site");
            }
            return await hostCall(method, [site, ...args]);
          },
        });
        for (const method of configuration.syncMethods) defineProperty(flow, method, {
          enumerable: true,
          value: (site, ...args) => {
            const record = sourceSiteRecords.get(site);
            if (!record || record.role !== "operation" || record.method !== method) {
              throw new SafeTypeError("flow." + method + " has the wrong reviewed source site");
            }
            return hostSyncCall(method, [site, ...args]);
          },
        });
        defineProperty(flow, "snapshot", {
          enumerable: true,
          get: () => {
            if (!snapshotPresent) throw new SafeError("flow.snapshot is unavailable");
            return snapshot;
          },
        });
        return freeze(flow);
      };

      return freeze({
        authority: value => authorityRecords.get(value),
        copyArray,
        copyObject,
        createError,
        createFlow,
        createRemoteAuthority,
        deepFreeze,
        language,
        sourceSite,
        sourceSiteRecord: value => sourceSiteRecords.get(value),
      });
    })
  `, { filename: "workflow-control-realm.js" });
  const initialize = bootstrap.runInContext(context, { timeout: 1_000 });
  return initialize(options.hostCall, options.hostSyncCall, options.metricCall, Object.freeze({
    asyncMethods: [...options.asyncMethods],
    syncMethods: [...options.syncMethods],
    metadata: options.metadata,
    descriptors: options.descriptors,
    operationSites: options.operationSites,
  }));
}

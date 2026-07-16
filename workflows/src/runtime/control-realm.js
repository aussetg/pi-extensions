import vm from "node:vm";

/**
 * Build every value visible to workflow source with the control context's
 * intrinsics. Host functions are captured only by context-realm wrappers and
 * never become properties of a workflow-visible object.
 */
export function createControlRealm(context, options) {
  const bootstrap = new vm.Script(`
    ((hostCall, hostMetric, metricCall) => {
      "use strict";
      const create = Object.create;
      const defineProperty = Object.defineProperty;
      const defineProperties = Object.defineProperties;
      const freeze = Object.freeze;
      const keys = Object.keys;
      const SafeError = Error;

      const copyArray = (values) => {
        const result = [];
        for (let index = 0; index < values.length; index += 1) result.push(values[index]);
        return result;
      };
      const copyObject = (entries) => {
        const result = create(null);
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          defineProperty(result, entry[0], {
            value: entry[1], enumerable: true, writable: true, configurable: true,
          });
        }
        return result;
      };
      const createError = (serialized) => {
        const error = new SafeError(serialized.message);
        defineProperty(error, "name", {
          value: serialized.name, enumerable: false, writable: true, configurable: true,
        });
        if (serialized.stack !== undefined) {
          defineProperty(error, "stack", {
            value: serialized.stack, enumerable: false, writable: true, configurable: true,
          });
        }
        if (serialized.properties !== undefined) {
          for (const key of keys(serialized.properties)) {
            defineProperty(error, key, {
              value: serialized.properties[key], enumerable: true, writable: true, configurable: true,
            });
          }
        }
        if (serialized.hostErrorId !== undefined) {
          defineProperty(error, "__flowHostErrorId", { value: serialized.hostErrorId });
        }
        return error;
      };
      const createMetric = (id) => {
        const invoke = (method, args) => metricCall(id, method, args);
        const handle = create(null);
        defineProperties(handle, {
          baseline: { enumerable: true, get: () => invoke("baseline", []) },
          current: { enumerable: true, get: () => invoke("current", []) },
          best: { enumerable: true, get: () => invoke("best", []) },
          relativeGain: { enumerable: true, get: () => invoke("relativeGain", []) },
          reachesTarget: { value: () => invoke("reachesTarget", []) },
          needsImprovement: { value: () => invoke("needsImprovement", []) },
          isImprovement: { value: (observation) => invoke("isImprovement", [observation]) },
          isWithinGuardrail: { value: (observation) => invoke("isWithinGuardrail", [observation]) },
          summary: { value: () => invoke("summary", []) },
        });
        return freeze(handle);
      };
      const createFlow = (hasSnapshot, snapshot) => {
        const flow = create(null);
        for (const method of ${JSON.stringify(options.asyncMethods)}) {
          defineProperty(flow, method, {
            enumerable: true,
            value: async (...args) => await hostCall(method, args),
          });
        }
        defineProperty(flow, "metric", {
          enumerable: true,
          value: (...args) => hostMetric(args),
        });
        defineProperty(flow, "snapshot", {
          enumerable: true,
          get: () => {
            if (!hasSnapshot) throw new SafeError("flow.snapshot is unavailable in this semantic runtime");
            return snapshot;
          },
        });
        return freeze(flow);
      };

      return freeze({
        copyArray,
        copyObject,
        createError,
        createFlow,
        createMetric,
        createReference: () => freeze(create(null)),
      });
    })
  `, { filename: "workflow-control-realm.js" });
  const initialize = bootstrap.runInContext(context, { timeout: 1_000 });
  return initialize(options.hostCall, options.hostMetric, options.metricCall);
}

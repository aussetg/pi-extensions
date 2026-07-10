export function StringEnum(values) {
  return { enum: values };
}

export const Type = {
  Array(items, options = {}) {
    return { ...options, items, type: "array" };
  },
  Boolean(options = {}) {
    return { ...options, type: "boolean" };
  },
  Integer(options = {}) {
    return { ...options, type: "integer" };
  },
  Number(options = {}) {
    return { ...options, type: "number" };
  },
  Object(properties, options = {}) {
    return { ...options, properties, type: "object" };
  },
  Optional(schema) {
    return schema;
  },
  String(options = {}) {
    return { ...options, type: "string" };
  },
};

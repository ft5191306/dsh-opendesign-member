/**
 * Minimal, dependency-free tool definition helper.
 *
 * Why not `defineTool` from `@deepseek-ai/dsh-tools`: this bundle is installed as
 * a linked directory, so Node resolves modules from its real path rather than
 * the profile's `node_modules`. Any peer import would then fail to resolve — and
 * a teammate bridge must keep working across DSH upgrades even if that package
 * layout changes. The registry accepts any structurally valid `ToolDefinition`,
 * so this file rebuilds the small validated wrapper locally.
 *
 * `ToolDefinition` shape (from `@deepseek-ai/dsh-llm` + `@deepseek-ai/dsh-tools`):
 *   { name, description, parameters: JSONSchema, output: { schema, render }, execute }
 *
 * @module @local/dsh-opendesign-member/lib/tool
 */

/**
 * Read the property bag from one compact parameter spec. Call sites may pass
 * either the bare property map or an envelope with a `properties` key.
 *
 * @param parameters - compact parameter spec.
 */
function propertyBag(parameters) {
  if (!parameters || typeof parameters !== 'object') return {};
  const nested = parameters.properties;
  if (nested && typeof nested === 'object') return nested;
  return parameters;
}

/**
 * Validate one argument bag against the compact parameter spec used below.
 * The spec is a subset of JSON Schema: each property may carry `type`,
 * `required`, `enum`, and `items`.
 *
 * @param parameters - compact parameter spec.
 * @param args - candidate arguments.
 * @returns a list of human-readable violations.
 */
function validateArgs(parameters, args) {
  const violations = [];
  const properties = propertyBag(parameters);
  const bag = args && typeof args === 'object' ? args : {};
  for (const [key, spec] of Object.entries(properties)) {
    const value = bag[key];
    if (value === undefined) {
      if (spec?.required === true) violations.push(`${key} is required`);
      continue;
    }
    const type = spec?.type;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (type === 'integer') {
      if (!Number.isInteger(value)) violations.push(`${key} must be an integer`);
    } else if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${key} must be a number`);
    } else if (type && actual !== type) {
      violations.push(`${key} must be ${type}`);
    }
    if (Array.isArray(spec?.enum) && !spec.enum.includes(value)) {
      violations.push(`${key} must be one of ${spec.enum.join(', ')}`);
    }
  }
  return violations;
}

/**
 * Expand a compact parameter spec into JSON Schema for the model.
 *
 * @param parameters - compact parameter spec.
 */
function toJsonSchema(parameters) {
  const properties = propertyBag(parameters);
  const converted = {};
  const required = [];
  for (const [key, spec] of Object.entries(properties)) {
    const node = { type: spec?.type ?? 'string' };
    if (typeof spec?.description === 'string') node.description = spec.description;
    if (Array.isArray(spec?.enum)) node.enum = spec.enum;
    if (spec?.type === 'array') node.items = spec.items ?? { type: 'string' };
    if (spec?.type === 'object') {
      node.type = 'object';
      node.additionalProperties = true;
    }
    converted[key] = node;
    if (spec?.required === true) required.push(key);
  }
  const schema = { type: 'object', additionalProperties: false, properties: converted };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Build one registered tool definition.
 *
 * @param options - name, description, compact parameters, output schema/render, execute.
 * @returns the structurally valid definition the registry accepts.
 */
export function defineTool(options) {
  const parameters = toJsonSchema(options.parameters);
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output.schema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validateArgs(options.parameters, args);
      if (violations.length > 0) {
        throw new Error(`${options.name} received invalid arguments: ${violations.join('; ')}`);
      }
      return await options.execute(args ?? {}, exec);
    },
  };
}

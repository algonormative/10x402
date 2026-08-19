// A JSON Schema validator, deliberately a SUBSET.
//
// It exists for exactly one check — V2_BAZAAR_INFO_VALIDATES — and that check
// is the reason this repo has a reason to exist. CDP's facilitator validates
// `extensions.bazaar.info` against `extensions.bazaar.schema` before it will
// catalogue a resource, and when the pair disagrees it declines SILENTLY: the
// endpoint keeps taking payments, keeps answering 402, and simply never appears
// in the directory. Nothing in the seller's logs mentions it. Reproducing that
// check locally is the difference between "my listing is missing, I wonder why"
// and a one-line diff.
//
// WHY NOT ajv. Two reasons, and the second is the real one.
//
//   1. It is a production dependency in a Workers bundle, for a validator that
//      runs over an object of maybe forty keys.
//   2. Ajv is STRICTER than the thing being modelled, and in the wrong
//      direction: it throws on schemas it considers malformed, so a seller with
//      a slightly odd but perfectly indexable schema would get an exception
//      rather than a report. Here an unknown keyword is IGNORED, which is what
//      JSON Schema itself specifies and what a lenient facilitator does.
//
// Supported: type, const, enum, required, properties, additionalProperties,
// items, minLength, maxLength, minimum, maximum, minItems, maxItems, pattern,
// anyOf, oneOf, allOf, not, $ref (local, "#/..." only), nullable.
//
// Anything else is ignored rather than failed. FALSE NEGATIVES ARE THE SAFER
// ERROR HERE: reporting a mismatch that is not real would send a seller to
// rewrite a schema that was already fine, which is worse than missing an exotic
// keyword nobody's bazaar block uses.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON Schema's `type`, which distinguishes integer from number and null from object. */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value; // 'string' | 'boolean' | 'object' | 'undefined'
}

const typeMatches = (value, want) =>
  want === 'number' ? typeOf(value) === 'number' || typeOf(value) === 'integer' : typeOf(value) === want;

/** Structural equality, order-insensitive for object keys. Used by `const` and `enum`. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Resolve a local "#/a/b" pointer against the root schema. Returns undefined if absent. */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  const path = ref.slice(1).split('/').filter(Boolean);
  let node = root;
  for (const raw of path) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) && !Array.isArray(node)) return undefined;
    node = node[key];
    if (node === undefined) return undefined;
  }
  return node;
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * Validate `value` against `schema`.
 *
 * @returns {string[]} one human sentence per problem, each naming the path. Empty means valid.
 */
export function validateAgainstSchema(value, schema, { root = schema, path = '$', depth = 0 } = {}) {
  const problems = [];

  // A pathological self-referential schema must not hang a paid request.
  if (depth > 24) return problems;
  // `true` admits everything, `false` admits nothing — both are legal schemas.
  if (schema === true) return problems;
  if (schema === false) return [`${path} is not allowed by the schema (schema is \`false\`)`];
  if (!isObject(schema)) return problems;

  if (schema.$ref !== undefined) {
    const target = resolveRef(root, schema.$ref);
    // An unresolvable $ref is the SCHEMA's bug, not the info's, and reporting it
    // as an info problem would point the seller at the wrong file.
    if (target !== undefined) {
      problems.push(...validateAgainstSchema(value, target, { root, path, depth: depth + 1 }));
    }
  }

  // --- type -------------------------------------------------------------
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    const allowNull = schema.nullable === true;
    if (!wanted.some((t) => typeMatches(value, t)) && !(allowNull && value === null)) {
      problems.push(`${path} should be ${wanted.join(' or ')} but is ${typeOf(value)}`);
      // Every remaining keyword assumes the type held, so stop here rather than
      // producing a cascade of derivative complaints about one root cause.
      return problems;
    }
  }

  // --- const / enum -----------------------------------------------------
  if ('const' in schema && !deepEqual(value, schema.const)) {
    problems.push(`${path} should be exactly ${short(schema.const)} but is ${short(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(value, option))) {
    problems.push(`${path} should be one of ${short(schema.enum)} but is ${short(value)}`);
  }

  // --- strings ----------------------------------------------------------
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      problems.push(`${path} is ${value.length} characters, below minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      problems.push(`${path} is ${value.length} characters, above maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      let re = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        /* an invalid pattern is the schema's bug; ignore rather than misreport */
      }
      if (re && !re.test(value)) problems.push(`${path} does not match pattern ${schema.pattern}`);
    }
  }

  // --- numbers ----------------------------------------------------------
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      problems.push(`${path} is ${value}, below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      problems.push(`${path} is ${value}, above maximum ${schema.maximum}`);
    }
  }

  // --- arrays -----------------------------------------------------------
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      problems.push(`${path} has ${value.length} items, below minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      problems.push(`${path} has ${value.length} items, above maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined && !Array.isArray(schema.items)) {
      value.forEach((item, i) => {
        problems.push(
          ...validateAgainstSchema(item, schema.items, { root, path: `${path}[${i}]`, depth: depth + 1 })
        );
      });
    }
  }

  // --- objects ----------------------------------------------------------
  if (isObject(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in value)) problems.push(`${path}.${key} is required by the schema but missing`);
    }

    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) {
        problems.push(
          ...validateAgainstSchema(value[key], sub, { root, path: `${path}.${key}`, depth: depth + 1 })
        );
      }
    }

    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      const patterns = isObject(schema.patternProperties) ? Object.keys(schema.patternProperties) : [];
      const extra = Object.keys(value).filter(
        (k) =>
          !(k in properties) &&
          !patterns.some((p) => {
            try {
              return new RegExp(p).test(k);
            } catch {
              return false;
            }
          })
      );
      if (schema.additionalProperties === false) {
        for (const key of extra) {
          problems.push(`${path}.${key} is not allowed (additionalProperties is false)`);
        }
      } else {
        for (const key of extra) {
          problems.push(
            ...validateAgainstSchema(value[key], schema.additionalProperties, {
              root,
              path: `${path}.${key}`,
              depth: depth + 1,
            })
          );
        }
      }
    }
  }

  // --- combinators ------------------------------------------------------
  //
  // Reported as ONE problem each rather than as the union of every branch's
  // complaints: "matches none of the 3 alternatives" is actionable, and forty
  // lines about the branches that were never meant to match are not.
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      problems.push(...validateAgainstSchema(value, sub, { root, path, depth: depth + 1 }));
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const ok = schema.anyOf.some(
      (sub) => validateAgainstSchema(value, sub, { root, path, depth: depth + 1 }).length === 0
    );
    if (!ok) problems.push(`${path} matches none of the ${schema.anyOf.length} anyOf alternatives`);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const matched = schema.oneOf.filter(
      (sub) => validateAgainstSchema(value, sub, { root, path, depth: depth + 1 }).length === 0
    ).length;
    if (matched !== 1) {
      problems.push(`${path} matches ${matched} of the ${schema.oneOf.length} oneOf alternatives, not exactly 1`);
    }
  }
  if (schema.not !== undefined) {
    if (validateAgainstSchema(value, schema.not, { root, path, depth: depth + 1 }).length === 0) {
      problems.push(`${path} matches the schema's \`not\` clause`);
    }
  }

  return problems;
}

// The JSON Schema subset. Pure, no worker.
//
// This validator exists for one check — V2_BAZAAR_INFO_VALIDATES — and that
// check makes a strong claim about somebody else's endpoint: "the facilitator
// will decline to catalogue this". A validator that is wrong in the STRICT
// direction sends a seller to rewrite a schema that was already fine, which is
// worse than missing an exotic keyword. So the negative cases below matter more
// than the positive ones, and there are deliberately several tests asserting
// that an unrecognised keyword is IGNORED.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateAgainstSchema } from '../worker/json-schema.js';

const valid = (value, schema) => {
  const problems = validateAgainstSchema(value, schema);
  assert.deepEqual(problems, [], `expected valid, got: ${problems.join('; ')}`);
};
const invalid = (value, schema, match) => {
  const problems = validateAgainstSchema(value, schema);
  assert.ok(problems.length > 0, 'expected at least one problem');
  if (match) assert.ok(problems.some((p) => p.includes(match)), `no problem mentioned "${match}": ${problems.join('; ')}`);
  return problems;
};

describe('type', () => {
  test('accepts the declared type', () => {
    valid('x', { type: 'string' });
    valid(1, { type: 'integer' });
    valid(1.5, { type: 'number' });
    valid(1, { type: 'number' }); // an integer IS a number
    valid([], { type: 'array' });
    valid({}, { type: 'object' });
    valid(null, { type: 'null' });
    valid(true, { type: 'boolean' });
  });

  test('rejects the wrong type and names both', () => {
    invalid(1, { type: 'string' }, 'should be string but is integer');
    invalid(1.5, { type: 'integer' }, 'should be integer but is number');
    invalid([], { type: 'object' }, 'should be object but is array');
    invalid(null, { type: 'object' }, 'should be object but is null');
  });

  test('accepts a union of types', () => {
    valid('x', { type: ['string', 'null'] });
    valid(null, { type: ['string', 'null'] });
    invalid(1, { type: ['string', 'null'] });
  });

  test('stops after a type mismatch instead of cascading', () => {
    // One root cause should produce one complaint, not one per keyword that
    // assumed the type held. A seller reading forty derivative lines will not
    // find the one that matters.
    const problems = validateAgainstSchema(42, {
      type: 'object',
      required: ['a', 'b', 'c'],
      properties: { a: { type: 'string' } },
    });
    assert.equal(problems.length, 1);
  });
});

describe('const and enum', () => {
  test('const compares structurally, not by reference', () => {
    valid('http', { const: 'http' });
    valid({ a: [1, 2] }, { const: { a: [1, 2] } });
    valid({ a: 1, b: 2 }, { const: { b: 2, a: 1 } }); // key order is not meaning
    invalid('json', { const: 'http' }, 'should be exactly "http"');
  });

  test('enum accepts any listed option', () => {
    valid('GET', { enum: ['GET', 'POST'] });
    invalid('PATCH', { enum: ['GET', 'POST'] }, 'should be one of');
  });
});

describe('objects', () => {
  const schema = {
    type: 'object',
    properties: {
      type: { type: 'string', const: 'http' },
      method: { type: 'string', const: 'POST' },
      body: { type: 'string', maxLength: 10 },
    },
    required: ['type', 'method'],
    additionalProperties: false,
  };

  test('accepts a conforming object', () => {
    valid({ type: 'http', method: 'POST', body: 'hi' }, schema);
  });

  test('names a missing required property by path', () => {
    invalid({ type: 'http' }, schema, '$.method is required by the schema but missing');
  });

  test('names an extra property when additionalProperties is false', () => {
    invalid(
      { type: 'http', method: 'POST', bodyType: 'text' },
      schema,
      '$.bodyType is not allowed (additionalProperties is false)'
    );
  });

  test('a schema-level rename breaks the pair in exactly the way the wild does', () => {
    // The real failure: someone renames a field in `info` and not in `schema`.
    // Two complaints, and between them they say precisely what happened.
    const problems = invalid({ type: 'http', method: 'GET' }, schema);
    assert.ok(problems.some((p) => p.includes('$.method should be exactly "POST"')));
  });

  test('validates nested properties by path', () => {
    invalid(
      { outer: { inner: 1 } },
      { type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'string' } } } } },
      '$.outer.inner should be string'
    );
  });

  test('additionalProperties as a schema validates the extras', () => {
    const s = { type: 'object', properties: {}, additionalProperties: { type: 'string' } };
    valid({ a: 'x', b: 'y' }, s);
    invalid({ a: 1 }, s, '$.a should be string');
  });
});

describe('strings, numbers and arrays', () => {
  test('minLength / maxLength', () => {
    valid('abc', { type: 'string', minLength: 1, maxLength: 5 });
    invalid('', { type: 'string', minLength: 1 }, 'below minLength');
    invalid('abcdef', { type: 'string', maxLength: 5 }, 'above maxLength');
  });

  test('pattern', () => {
    valid('0x00', { type: 'string', pattern: '^0x' });
    invalid('00', { type: 'string', pattern: '^0x' }, 'does not match pattern');
  });

  test('an invalid pattern in the schema is ignored, not reported against the value', () => {
    // The schema is broken, not the info. Blaming the info would send the
    // seller to fix the wrong file.
    valid('anything', { type: 'string', pattern: '([' });
  });

  test('minimum / maximum', () => {
    valid(5, { type: 'integer', minimum: 1, maximum: 10 });
    invalid(0, { type: 'integer', minimum: 1 }, 'below minimum');
    invalid(11, { type: 'integer', maximum: 10 }, 'above maximum');
  });

  test('items and item counts', () => {
    valid(['a', 'b'], { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 });
    invalid(['a', 1], { type: 'array', items: { type: 'string' } }, '$[1] should be string');
    invalid([], { type: 'array', minItems: 1 }, 'below minItems');
    invalid([1, 2, 3], { type: 'array', maxItems: 2 }, 'above maxItems');
  });
});

describe('combinators', () => {
  test('anyOf reports one problem, not every branch', () => {
    const s = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    valid('x', s);
    valid(1, s);
    const problems = invalid(true, s, 'matches none of the 2 anyOf alternatives');
    assert.equal(problems.length, 1);
  });

  test('oneOf requires exactly one match', () => {
    const s = { oneOf: [{ type: 'string' }, { type: 'string', maxLength: 2 }] };
    invalid('ab', s, 'matches 2 of the 2 oneOf alternatives');
    valid('abcdef', s);
  });

  test('allOf applies every branch', () => {
    const s = { allOf: [{ type: 'string' }, { minLength: 3 }] };
    valid('abc', s);
    invalid('ab', s, 'below minLength');
  });

  test('not inverts', () => {
    valid(1, { not: { type: 'string' } });
    invalid('x', { not: { type: 'string' } }, "matches the schema's `not` clause");
  });
});

describe('leniency, which is a deliberate design choice', () => {
  test('unknown keywords are ignored rather than failed', () => {
    // JSON Schema specifies this, and a lenient facilitator does it. Failing on
    // an unrecognised keyword would report a mismatch that is not real.
    valid('x', { type: 'string', format: 'email', deprecated: true, examples: ['a'], 'x-vendor': 1 });
  });

  test('a non-object schema admits everything', () => {
    valid({ anything: true }, null);
    valid({ anything: true }, 'not a schema');
    valid({ anything: true }, true);
  });

  test('`false` as a schema admits nothing', () => {
    invalid({}, false, 'is not allowed');
  });

  test('an unresolvable $ref is ignored rather than blamed on the value', () => {
    valid('x', { $ref: '#/definitions/nope' });
  });

  test('a resolvable local $ref is followed', () => {
    const schema = {
      $defs: { name: { type: 'string', minLength: 2 } },
      type: 'object',
      properties: { a: { $ref: '#/$defs/name' } },
    };
    valid({ a: 'ok' }, schema);
    invalid({ a: 'x' }, schema, '$.a is 1 characters, below minLength 2');
  });

  test('a self-referential schema terminates instead of hanging', () => {
    // A paid request must not be turnable into an infinite loop by a hostile
    // envelope. The depth cap is the whole defence and this is its proof.
    const schema = { type: 'object', properties: {} };
    schema.properties.next = schema;
    const deep = {};
    let cursor = deep;
    for (let i = 0; i < 200; i++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    const problems = validateAgainstSchema(deep, schema);
    assert.ok(Array.isArray(problems));
  });
});

describe('the real bazaar shape', () => {
  // The exact pair this service publishes, and the exact way it breaks.
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'http' },
          method: { type: 'string', const: 'POST' },
          bodyType: { type: 'string', const: 'text' },
          body: { type: 'string', maxLength: 262144 },
        },
        required: ['type', 'method', 'bodyType', 'body'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'text' },
          format: { type: 'string', const: 'application/json' },
          example: { type: 'string' },
        },
        required: ['type', 'format'],
        additionalProperties: false,
      },
    },
    required: ['input'],
  };

  const info = () => ({
    input: { type: 'http', method: 'POST', bodyType: 'text', body: '{"url":"https://x.example/y"}' },
    output: { type: 'text', format: 'application/json', example: '{"grade":"A"}' },
  });

  test('the matched pair validates', () => {
    valid(info(), schema);
  });

  test('output is optional because the schema does not require it', () => {
    const partial = info();
    delete partial.output;
    valid(partial, schema);
  });

  test('a bodyType rename on one side only is caught', () => {
    const drifted = info();
    drifted.input.bodyType = 'json';
    invalid(drifted, schema, '$.input.bodyType should be exactly "text"');
  });

  test('an added field with additionalProperties false is caught', () => {
    const drifted = info();
    drifted.input.headers = {};
    invalid(drifted, schema, '$.input.headers is not allowed');
  });

  test('a dropped required field is caught', () => {
    const drifted = info();
    delete drifted.input.body;
    invalid(drifted, schema, '$.input.body is required by the schema but missing');
  });
});

describe('the work budget, because the schema is the caller’s', () => {
  // THE DEPTH CAP WAS NOT A BOUND ON WORK. `anyOf` with n branches, each
  // holding a `$ref` back to its own parent, describes n^depth distinct paths
  // through a document whose SIZE is linear — so the depth cap stopped the
  // walk going deeper while doing nothing about how wide it got on the way.
  // Measured on this exact shape before the budget existed:
  //
  //     352 bytes -> 932 ms   403 bytes -> 3132 ms   454 bytes -> 8896 ms
  //
  // Two more branches exceed any Workers CPU limit, from half a kilobyte of
  // request body on a $0.005 endpoint. Bounding the report to 256 KB is not
  // much use if producing it can be made to cost ten seconds of isolate.
  const exponential = (branches) => ({
    $defs: {
      a: {
        anyOf: Array.from({ length: branches }, () => ({
          allOf: [{ $ref: '#/$defs/a' }, { type: 'string' }],
        })),
      },
    },
    $ref: '#/$defs/a',
  });

  test('an exponential schema is bounded to milliseconds, not seconds', () => {
    for (const branches of [6, 7, 8]) {
      const schema = exponential(branches);
      const started = Date.now();
      validateAgainstSchema({ input: {} }, schema);
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < 500,
        `anyOf x${branches} (${JSON.stringify(schema).length} bytes) took ${elapsed}ms`
      );
    }
  });

  test('it SAYS it stopped — an unchecked schema must not read as a passing one', () => {
    // The whole failure mode this file exists to catch is a silent decline.
    // Declining silently ourselves would be the same bug on the other side.
    const problems = validateAgainstSchema({ input: {} }, exponential(8));
    assert.ok(problems.length > 0, 'a schema too expensive to check reported no problems');
    assert.ok(
      problems.some((p) => /validation stopped after \d+ schema nodes/.test(p)),
      JSON.stringify(problems.slice(0, 3))
    );
    assert.ok(problems.some((p) => /\$ref cycle/.test(p)), 'the report does not say what to look for');
  });

  test('the budget is spent across the whole validation, not per branch', () => {
    // A per-branch limit is no limit at all when the branching IS the attack.
    const wide = {
      $defs: { a: { anyOf: Array.from({ length: 40 }, () => ({ $ref: '#/$defs/a' })) } },
      $ref: '#/$defs/a',
    };
    const started = Date.now();
    validateAgainstSchema({}, wide);
    assert.ok(Date.now() - started < 500, 'a wide fan-out outran the budget');
  });

  test('this service OWN bazaar pair is nowhere near the budget', async () => {
    // The bound must be invisible to every honest caller, or it is a bug of its
    // own — and the reference for honest is the pair this service publishes
    // about itself, which the self-lint already requires to validate clean.
    const { bazaarExtension, paymentRequirements } = await import('../worker/envelope.js');
    const { ENDPOINTS } = await import('../worker/catalog.js');
    for (const endpoint of ENDPOINTS) {
      const requirements = paymentRequirements(endpoint, '0x000000000000000000000000000000000000dEaD');
      const pair = bazaarExtension(requirements, endpoint).bazaar;
      assert.deepEqual(validateAgainstSchema(pair.info, pair.schema), [], endpoint.path);
    }
  });
});

// The SSRF guard's RULES, as pure functions. No worker, no network.
//
// checkTargetUrl() is exported precisely so this file can exist. A guard whose
// branches are only reachable through a live request is a guard nobody has
// actually read, and the branches that matter here are the ones a real attacker
// would go looking for — the notations that are the same address written
// differently.
//
// The behaviour these assert is the SHIPPED behaviour: every call below uses
// the default (unsafe: false), which is what production runs.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkTargetUrl, timeoutMs, unsafeTargetsAllowed } from '../worker/fetch-target.js';

const rejects = (url, match) => {
  const result = checkTargetUrl(url);
  assert.ok(result.error, `expected ${url} to be refused, got ${JSON.stringify(result.url?.href)}`);
  if (match) assert.match(result.error, match);
  // Every refusal must say what to do instead, or the caller has paid for the
  // word "no".
  assert.ok(result.fix && result.fix.length > 40, `refusal of ${url} carries no usable fix`);
  return result;
};

const accepts = (url) => {
  const result = checkTargetUrl(url);
  assert.ok(!result.error, `expected ${url} to be accepted, got: ${result.error}`);
  return result.url;
};

describe('scheme', () => {
  test('accepts https', () => {
    assert.equal(accepts('https://example.com/api').protocol, 'https:');
  });
  test('refuses http', () => {
    rejects('http://example.com/api', /must be https/);
  });
  test('refuses other schemes outright', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/']) {
      rejects(url, /must be https/);
    }
  });
  test('refuses a relative or scheme-less URL with advice about the scheme', () => {
    rejects('example.com/api', /not a valid absolute URL/);
    rejects('/api/thing', /not a valid absolute URL/);
  });
});

describe('loopback and private IPv4', () => {
  const cases = [
    ['https://127.0.0.1/x', /127\.0\.0\.0\/8/],
    ['https://127.1.2.3/x', /127\.0\.0\.0\/8/],
    ['https://10.0.0.1/x', /10\.0\.0\.0\/8/],
    ['https://10.255.255.255/x', /10\.0\.0\.0\/8/],
    ['https://172.16.0.1/x', /172\.16\.0\.0\/12/],
    ['https://172.31.255.1/x', /172\.16\.0\.0\/12/],
    ['https://192.168.1.1/x', /192\.168\.0\.0\/16/],
    ['https://169.254.169.254/latest/meta-data/', /169\.254\.0\.0\/16/],
    ['https://100.64.0.1/x', /100\.64\.0\.0\/10/],
    ['https://0.0.0.0/x', /0\.0\.0\.0\/8/],
    ['https://255.255.255.255/x', /multicast|reserved/],
  ];
  for (const [url, match] of cases) {
    test(`refuses ${url}`, () => rejects(url, match));
  }

  test('names the range so the caller can see the rule, not just the verdict', () => {
    const { error } = checkTargetUrl('https://169.254.169.254/');
    assert.match(error, /link-local/);
    assert.match(error, /metadata/);
  });

  test('does not over-block the public neighbours of private ranges', () => {
    // 172.15 and 172.32 are public; a guard that blocked them would be
    // refusing real endpoints, which is the failure nobody reports.
    accepts('https://172.15.0.1/x');
    accepts('https://172.32.0.1/x');
    accepts('https://11.0.0.1/x');
    accepts('https://192.167.1.1/x');
    accepts('https://100.63.0.1/x');
    accepts('https://100.128.0.1/x');
  });
});

describe('IPv6, including the notations that are the same address written differently', () => {
  const cases = [
    ['https://[::1]/x', /loopback/],
    ['https://[::]/x', /unspecified/],
    ['https://[fc00::1]/x', /fc00::\/7/],
    ['https://[fd12:3456::1]/x', /fc00::\/7/],
    ['https://[fe80::1]/x', /fe80::\/10/],
    ['https://[ff02::1]/x', /multicast/],
  ];
  for (const [url, match] of cases) {
    test(`refuses ${url}`, () => rejects(url, match));
  }

  test('refuses an IPv4-mapped loopback in dotted form', () => {
    rejects('https://[::ffff:127.0.0.1]/x', /IPv4-mapped/);
  });

  test('refuses an IPv4-mapped loopback in hex form', () => {
    // ::ffff:7f00:1 IS 127.0.0.1. Changing notation must not change the answer.
    rejects('https://[::ffff:7f00:1]/x', /IPv4-mapped/);
  });

  test('refuses an IPv4-mapped link-local metadata address', () => {
    rejects('https://[::ffff:169.254.169.254]/x', /IPv4-mapped/);
  });

  test('refuses the IPv4-compatible forms, which are IPv4 addresses in disguise', () => {
    // ::7f00:1 and ::127.0.0.1 are both 127.0.0.1. The range is deprecated by
    // RFC 4291 and nothing public lives in it, so the whole /96 goes rather
    // than only the private addresses inside it.
    rejects('https://[::7f00:1]/x', /IPv4-compatible/);
    rejects('https://[::127.0.0.1]/x', /IPv4-compatible/);
    rejects('https://[::c0a8:101]/x', /IPv4-compatible/);
  });

  test('refuses NAT64, which embeds an IPv4 address for a gateway to unwrap', () => {
    // 64:ff9b::7f00:1 is a way of writing 127.0.0.1 that reaches it through a
    // NAT64 gateway. Whether the surrounding network has one is not knowable
    // from inside a Worker, which is why the range is refused rather than decoded.
    rejects('https://[64:ff9b::7f00:1]/x', /NAT64/);
    rejects('https://[64:ff9b::1]/x', /NAT64/);
  });

  test('accepts a public IPv6 address', () => {
    accepts('https://[2606:4700:4700::1111]/x');
  });
});

describe('ports, because a linter that dials anything is a port scanner', () => {
  test('accepts the default port and the explicit https ones', () => {
    assert.equal(accepts('https://example.com/api').port, '');
    assert.equal(accepts('https://example.com:443/api').port, '');
    assert.equal(accepts('https://staging.example.com:8443/api').port, '8443');
  });

  const scanned = ['22', '25', '3306', '5432', '6379', '8080', '9200', '11211'];
  for (const port of scanned) {
    test(`refuses port ${port}`, () => rejects(`https://example.com:${port}/x`, /only 443 and 8443/));
  }

  test('an address refused for WHAT it is says so, not which port it was on', () => {
    // Ordering, and it is a real choice: both refuse before any connection, so
    // the oracle is closed either way, and "that is loopback" is the more
    // useful sentence for the person who typed it by accident.
    rejects('https://127.0.0.1:8787/lint', /127\.0\.0\.0\/8/);
    rejects('https://localhost:9999/lint', /private-network name/);
  });
});

describe('a trailing dot is the same name', () => {
  // `localhost.` is the fully qualified form of `localhost` and resolves
  // identically. It matched no blocked name and no suffix, and `127.0.0.1.`
  // split into five parts so it was not read as a dotted quad either — one
  // character walked past every name rule there was.
  test('refuses the fully qualified forms of the blocked names', () => {
    rejects('https://localhost./x', /private-network name/);
    rejects('https://metadata.internal./x', /private-network name/);
    rejects('https://printer.local./x', /private-network name/);
  });

  test('refuses a fully qualified loopback address', () => {
    rejects('https://127.0.0.1./x', /127\.0\.0\.0\/8/);
  });

  test('refuses a fully qualified bare hostname', () => {
    rejects('https://redis./x', /bare hostname/);
  });

  test('does not break an ordinary fully qualified public name', () => {
    accepts('https://example.com./api');
  });
});

describe('names that only resolve inside a network', () => {
  const cases = [
    'https://localhost/x',
    'https://LOCALHOST/x',
    'https://foo.localhost/x',
    'https://metadata.internal/x',
    'https://db.svc.internal/x',
    'https://printer.local/x',
    'https://router.home.arpa/x',
  ];
  for (const url of cases) {
    test(`refuses ${url}`, () => rejects(url, /private-network name|only resolves inside/));
  }

  test('refuses a bare hostname with no dot', () => {
    // `https://redis/` is a container-network name, and it is the one people
    // actually paste by accident.
    rejects('https://redis/x', /bare hostname/);
    rejects('https://vault/x', /bare hostname/);
  });

  test('accepts ordinary public hostnames', () => {
    accepts('https://example.com/api');
    accepts('https://api.example.co.uk/v1/thing');
    accepts('https://toolshed.lemon-agent.dev/convert/md-html');
    // Not a special case: `.internal` is blocked as a suffix, and this is not one.
    accepts('https://internal-tools.example.com/x');
  });
});

describe('other refusals', () => {
  test('refuses credentials in the authority', () => {
    rejects('https://user:pass@example.com/x', /credentials/);
  });
  test('refuses an absurdly long URL', () => {
    rejects(`https://example.com/${'a'.repeat(4000)}`, /longer than/);
  });
  test('refuses an empty or missing url', () => {
    rejects('', /required/);
    rejects('   ', /required/);
    assert.ok(checkTargetUrl(undefined).error);
    assert.ok(checkTargetUrl(null).error);
    assert.ok(checkTargetUrl(42).error);
  });
  test('every refusal points at /lint/envelope where that is the real answer', () => {
    // Someone linting localhost has a legitimate need. Refusing without naming
    // the endpoint that WOULD work is refusing a customer.
    for (const url of ['https://127.0.0.1/x', 'https://localhost/x', 'https://redis/x']) {
      assert.match(checkTargetUrl(url).fix, /lint\/envelope/);
    }
  });
});

describe('the unsafe gate', () => {
  test('is off unless the var is exactly "1"', () => {
    assert.equal(unsafeTargetsAllowed({}), false);
    assert.equal(unsafeTargetsAllowed({ LINT_UNSAFE_TARGETS: '' }), false);
    assert.equal(unsafeTargetsAllowed({ LINT_UNSAFE_TARGETS: '0' }), false);
    assert.equal(unsafeTargetsAllowed({ LINT_UNSAFE_TARGETS: 'true' }), false);
    assert.equal(unsafeTargetsAllowed({ LINT_UNSAFE_TARGETS: 'yes' }), false);
    assert.equal(unsafeTargetsAllowed({ LINT_UNSAFE_TARGETS: '1' }), true);
  });

  test('when on, it relaxes both the scheme and the address rules', () => {
    const result = checkTargetUrl('http://127.0.0.1:8080/x', { unsafe: true });
    assert.ok(!result.error, result.error);
    assert.equal(result.url.port, '8080');
  });

  test('a malformed URL is still refused with the gate open', () => {
    // The gate relaxes policy, not parsing. Nothing downstream should ever see
    // something that is not a URL.
    assert.ok(checkTargetUrl('not a url', { unsafe: true }).error);
  });
});

describe('the timeout', () => {
  test('defaults to ten seconds', () => {
    assert.equal(timeoutMs({}), 10_000);
    assert.equal(timeoutMs(undefined), 10_000);
  });
  test('is clamped so a bad value cannot unbound it or zero it', () => {
    assert.equal(timeoutMs({ LINT_TIMEOUT_MS: '99999999' }), 10_000);
    assert.equal(timeoutMs({ LINT_TIMEOUT_MS: '0' }), 200);
    assert.equal(timeoutMs({ LINT_TIMEOUT_MS: '-5' }), 200);
    assert.equal(timeoutMs({ LINT_TIMEOUT_MS: 'banana' }), 10_000);
  });
  test('honours a value inside the range', () => {
    assert.equal(timeoutMs({ LINT_TIMEOUT_MS: '700' }), 700);
  });
});

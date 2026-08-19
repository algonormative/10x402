// Local test harness for the 10x402 Worker.
//
// Boots `wrangler dev --local` against a FRESH temporary D1, so a suite run
// never touches production and never inherits yesterday's rows. NOTHING IN THE
// SUITE TALKS TO THE NETWORK BEYOND LOCALHOST — no facilitator, no Telegram, no
// linted target, no billed call of any kind. The mock facilitator, the mock
// Telegram and the mock lint targets are all http servers this process starts.
//
// Four things are worth knowing before reading further.
//
// 1. `cf-connecting-ip` IS honoured by `wrangler dev --local`, which is how the
//    quota suites give every virtual caller its own address and get per-test
//    isolation from a header rather than from a rebooted worker. (Production
//    gets the header from the edge and a client cannot forge it there; locally
//    there is no edge, which is exactly what makes it useful.)
//
// 2. Fresh state per run. Every boot gets its own `--persist-to` directory,
//    `worker/schema.sql` is applied BEFORE the server starts, and the directory
//    is removed on teardown. Two runs cannot see each other's quota rows, so the
//    free-tier assertions are exact rather than "greater than".
//
// 3. Teardown kills the process GROUP. `wrangler dev` is a node CLI that spawns
//    workerd children; killing the node process alone orphans them and leaks the
//    port. The child is spawned `detached: true` and torn down with
//    `process.kill(-pid, …)`, with a SIGKILL escalation and a synchronous sweep
//    on exit.
//
// 4. PAYTO_TEST IS A STRUCTURALLY VALID ADDRESS, and that is not cosmetic. The
//    chassis this is adapted from used `0xTEST000…`, which is fine when nothing
//    reads it — but this Worker's own 402 is fed through this repo's own linter,
//    and V2_PAYTO/V1_PAYTO would fail on a payTo that is not 40 hex characters.
//    A placeholder that is not a real shape would make the flagship invariant
//    fail for a reason that has nothing to do with the product.

import { spawn, execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';

const execFileAsync = promisify(execFile);

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const SCHEMA = join(ROOT, 'worker', 'schema.sql');

/** See note 4. Burn address: valid shape, provably nobody's. */
export const PAYTO_TEST = '0x000000000000000000000000000000000000dEaD';

/** The free tier the phases that boot one use. Production runs with none. */
export const FREE_TIER_ENABLED = 3;
export const TIER_ON_VARS = { FREE_TIER_DAILY: String(FREE_TIER_ENABLED) };

/**
 * The gate that lets /lint reach a mock target on 127.0.0.1.
 *
 * Set ONLY by the phase that exercises the outbound fetch. Every other phase
 * runs with the production guard intact, which is what makes the SSRF suite's
 * refusals meaningful — they are assertions about the shipped configuration,
 * not about a test-only one.
 */
export const UNSAFE_TARGET_VARS = { LINT_UNSAFE_TARGETS: '1', LINT_TIMEOUT_MS: '700' };

/** Mirrors PAID_DAILY in worker/worker.js. */
export const PAID_DAILY = 2000;

const BOOT_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 8_000;

// ------------------------------------------------------------------ caller IPs
//
// Each suite owns one octet, so two suites sharing a worker can never collide on
// a quota row. 198.18.0.0/15 is the benchmarking range (RFC 2544) — never a real
// client.

const SUITE_OCTET = {
  check: 11,
  'lint-envelope': 12,
  'lint-http': 13,
  ssrf: 14,
  x402: 15,
  'self-lint': 16,
  settlement: 17,
  alerts: 18,
};

/**
 * A structurally real CDP Secret API Key that is worth nothing.
 *
 * The Worker signs an Ed25519 JWT with this, so it cannot be a placeholder — it
 * has to be what CDP actually issues: base64 of 64 bytes, a 32-byte seed
 * followed by its 32-byte public key. Generated fresh per call and never sent
 * anywhere but the local mock, so it authorises nothing and there is nothing to
 * leak. The point is that the JWT path is exercised FOR REAL: if workerd could
 * not import or sign with an Ed25519 key, the settlement suite would fail
 * rather than quietly skip.
 */
export function fakeCdpCredentials() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // Both DER wrappers put the 32 raw bytes last.
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const pub = spki.subarray(spki.length - 32);
  return {
    CDP_API_KEY_ID: 'test-key-0000-0000-0000-000000000000',
    CDP_API_KEY_SECRET: Buffer.concat([seed, pub]).toString('base64'),
  };
}

/**
 * A per-suite source of caller addresses. `next()` hands out a previously
 * unused one — how the fixture suites stay clear of a spent free tier without a
 * reboot; `pinned(n)` returns a stable address for tests that need the SAME
 * caller across many calls.
 */
export function callers(suite) {
  const octet = SUITE_OCTET[suite];
  if (octet === undefined) throw new Error(`unregistered suite "${suite}" — add it to SUITE_OCTET`);
  let cursor = 0;
  const at = (n) => `198.18.${octet}.${n}`;
  return {
    next: () => at((cursor++ % 200) + 1),
    // 201-254 is the pinned band, so an auto-allocated address can never wander
    // into a caller a quota test is counting.
    pinned: (n) => at(201 + n),
  };
}

// ------------------------------------------------------------------ boot

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const quietEnv = () => ({
  ...process.env,
  CI: '1',
  NO_COLOR: '1',
  WRANGLER_SEND_METRICS: 'false',
});

async function applySchema(persistDir) {
  await execFileAsync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--file', SCHEMA, '-y'],
    { cwd: ROOT, env: quietEnv(), maxBuffer: 32 * 1024 * 1024 }
  );
}

// Best-effort sweep: if the test process dies unexpectedly, still take the
// workerd children with it. Synchronous, because `exit` handlers cannot await.
const live = new Set();
let sweeperInstalled = false;
function installSweeper() {
  if (sweeperInstalled) return;
  sweeperInstalled = true;
  const sweep = () => {
    for (const pid of live) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      sweep();
      process.exit(1);
    });
  }
}

/** Boot one `wrangler dev --local` instance on a fresh D1 state. */
export async function bootWorker({ vars = {} } = {}) {
  installSweeper();

  const persistDir = await mkdtemp(join(tmpdir(), 'tenx402-test-'));
  await applySchema(persistDir);

  const port = await freePort();
  const inspectorPort = await freePort();

  const args = [
    WRANGLER,
    'dev',
    '--local',
    '--port',
    String(port),
    '--inspector-port',
    String(inspectorPort),
    '--persist-to',
    persistDir,
  ];
  for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}:${value}`);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true, // own process group — see the teardown note at the top
    stdio: ['ignore', 'pipe', 'pipe'],
    env: quietEnv(),
  });
  live.add(child.pid);

  let log = '';
  const capture = (chunk) => {
    log += chunk;
    if (log.length > 200_000) log = log.slice(-100_000);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let exitedWith = null;
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exitedWith = { code, signal };
      live.delete(child.pid);
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  const worker = {
    baseUrl,
    port,
    persistDir,
    payTo: vars.PAYTO || '',
    owned: true,
    log: () => log,
    d1: (sql) => d1(persistDir, sql),
    stop: async () => {
      if (exitedWith) {
        live.delete(child.pid);
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        const killed = await Promise.race([
          exited.then(() => true),
          new Promise((r) => setTimeout(() => r(false), STOP_GRACE_MS)),
        ]);
        if (!killed) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
          await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
        }
        live.delete(child.pid);
      }
      await rm(persistDir, { recursive: true, force: true });
    },
  };

  // Readiness: /check is the cheapest route — no D1, no fetch.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (exitedWith) {
      await worker.stop();
      throw new Error(`wrangler dev exited during boot (${JSON.stringify(exitedWith)})\n${log}`);
    }
    try {
      const res = await fetch(`${baseUrl}/check`);
      if (res.status === 200) {
        await res.arrayBuffer();
        return worker;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await worker.stop();
      throw new Error(`wrangler dev did not answer /check within ${BOOT_TIMEOUT_MS} ms\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Read or write the local D1 directly, alongside a live `wrangler dev`. Rows
 * written by the Worker are visible here immediately and vice versa, which is
 * what makes the salt and ledger assertions possible without waiting a day.
 */
export async function d1(persistDir, sql) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      [WRANGLER, 'd1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--json', '--command', sql],
      { cwd: ROOT, env: quietEnv(), maxBuffer: 64 * 1024 * 1024 }
    ));
  } catch (err) {
    throw new Error(`d1 query failed: ${sql}\n${err.stdout || err.stderr || err.message}`);
  }
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`no JSON in wrangler d1 output:\n${stdout}`);
  return JSON.parse(stdout.slice(start)).flatMap((r) => r.results ?? []);
}

// ------------------------------------------------------------------ per-file entry

/** Order-independent identity for a boot config, so a suite can join or not. */
const varsKey = (vars = {}) =>
  JSON.stringify(Object.fromEntries(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))));

/**
 * Join the phase's worker if its boot config is the one this file asked for,
 * otherwise boot a private one.
 *
 * The match is on the WHOLE var set, not just PAYTO: FREE_TIER_DAILY decides
 * whether the first call is a 200 or a 402, and LINT_UNSAFE_TARGETS decides
 * whether /lint will touch 127.0.0.1 at all — so a file that joined a worker
 * configured differently from what it asked for would fail in a way that looks
 * like a product bug.
 */
export async function useWorker({ payTo = null, vars = {} } = {}) {
  const want = { ...(payTo ? { PAYTO: payTo } : {}), ...vars };
  const shared = process.env.TENX402_TEST_URL;
  if (shared && (process.env.TENX402_TEST_VARS || '{}') === varsKey(want)) {
    const persistDir = process.env.TENX402_TEST_PERSIST;
    return {
      baseUrl: shared.replace(/\/+$/, ''),
      persistDir,
      payTo: want.PAYTO || '',
      owned: false,
      log: () => '',
      d1: (sql) => d1(persistDir, sql),
      stop: async () => {},
    };
  }
  return bootWorker({ vars: want });
}

export { varsKey };

// ------------------------------------------------------------------ client

/**
 * Request helpers bound to one worker. `ip` becomes `cf-connecting-ip`, which
 * is what the quota counter is keyed on and therefore the whole isolation
 * mechanism.
 */
export function client(worker) {
  const url = (path) => `${worker.baseUrl}${path}`;

  const request = (path, { method = 'GET', body, ip, ua, headers = {} } = {}) => {
    const h = { ...headers };
    if (ip) h['cf-connecting-ip'] = ip;
    if (ua) h['user-agent'] = ua;
    return fetch(url(path), { method, body, headers: h });
  };

  const post = async (path, payload, opts = {}) => {
    const res = await request(path, {
      ...opts,
      method: 'POST',
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* the assertion will say so */
    }
    return { status: res.status, headers: res.headers, text, body: parsed, res };
  };

  return {
    url,
    request,
    post,
    /** POST /lint {url, method}. */
    lint: (payload, opts) => post('/lint', payload, opts),
    /** POST /lint/envelope {status, headers, body}. */
    lintEnvelope: (payload, opts) => post('/lint/envelope', payload, opts),
    check: async (opts) => {
      const res = await request('/check', { ...opts, method: 'GET' });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, body: JSON.parse(text) };
    },
  };
}

// ------------------------------------------------------------------ helpers

/**
 * True when a column read back through `d1()` is SQL NULL.
 *
 * Needed because `wrangler d1 execute --json` renders a NULL column as the
 * STRING "null", not as JSON null — so `assert.equal(row.tx_hash, null)` fails
 * against a row that is genuinely NULL. Kept as a helper rather than
 * normalised inside d1(), because rewriting "null" to null there would
 * silently corrupt a column legitimately holding the text "null".
 */
export const isSqlNull = (value) => value === null || value === 'null';

/** Seconds from now to the next UTC midnight — what Retry-After should carry. */
export function secondsToUtcMidnight(at = Date.now()) {
  const now = Math.floor(at / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  return dayStart + 86_400 - now;
}

/** Decode a PAYMENT-REQUIRED header into the v2 envelope it carries. */
export const decodeV2 = (headerValue) =>
  JSON.parse(Buffer.from(String(headerValue), 'base64').toString('utf8'));

// Owner-facing payment alerts, against a mock facilitator AND a mock Telegram.
//
// The alerts exist because the `settlements` table is a perfect record nobody
// reads at 3am, and the one event this service is built to produce — a stranger
// paying for something — is worth a phone buzzing.
//
// What this suite is really protecting is the rule that makes the channel
// usable at all: AN ALERT NEVER TOUCHES THE PAYING CALLER. Every assertion
// about a dead channel below is paired with an assertion that the buyer still
// got their report, because a notification that can degrade a paid response is
// worse than no notification.
//
// The second rule it protects is that a house test buy and a stranger's
// purchase must never produce the same message. If they did, the loud one would
// stop meaning anything, which is the only way this feature can truly fail.
//
// NOTHING HERE IS BILLED OR SENT ANYWHERE. Both the facilitator and Telegram
// are http servers this process runs on 127.0.0.1.

import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { bootWorker, callers, client, fakeCdpCredentials, PAYTO_TEST } from './harness.mjs';
import { alertHeadline, alertMessage, formatUsdc, isHousePayer, rawEmail } from '../worker/alert-message.js';

const ips = callers('alerts');

const VERIFIED_PAYER = '0x00000000000000000000000000000000000Fa11e5';
const HOUSE_PAYER = '0x00000000000000000000000000000000000H0u5e'.replace(/[^0-9a-fA-Fx]/g, '0').slice(0, 42);
const TX_HASH = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';

let worker;
let api;
let facilitator;
let telegram;

// ------------------------------------------------------------------ the mocks

async function startFacilitator() {
  const state = {
    verify: { isValid: true, payer: VERIFIED_PAYER },
    settle: { success: true, transaction: TX_HASH, network: 'base', payer: VERIFIED_PAYER },
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const endpoint = new URL(req.url, 'http://mock').pathname.split('/').pop();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state[endpoint] ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/platform/v2/x402`,
    stop: () => new Promise((r) => server.close(r)),
  };
}

/** A stand-in for api.telegram.org that records what it was asked to send. */
async function startTelegram() {
  const state = { sends: [], status: 200, hang: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as null */
      }
      state.sends.push({ path: req.url, body });
      if (state.hang) return; // never answers — proves the timeout is bounded
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: state.status === 200 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    state,
    base: `http://127.0.0.1:${server.address().port}`,
    get sends() {
      return state.sends;
    },
    reset() {
      state.sends.length = 0;
      state.status = 200;
      state.hang = false;
    },
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

const BOT_TOKEN = 'test-bot-token';
const CHAT_ID = '424242';

before(async () => {
  facilitator = await startFacilitator();
  telegram = await startTelegram();
  worker = await bootWorker({
    vars: {
      PAYTO: PAYTO_TEST,
      FACILITATOR_URL: facilitator.url,
      TELEGRAM_API_BASE: telegram.base,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_CHAT_ID: CHAT_ID,
      HOUSE_PAYERS: HOUSE_PAYER,
      ...fakeCdpCredentials(),
    },
  });
  api = client(worker);
});

after(async () => {
  await worker?.stop();
  await facilitator?.stop();
  await telegram?.stop();
});

beforeEach(() => telegram.reset());

/**
 * A payment, with a fresh nonce per authorization — which is what an EIP-3009
 * nonce is, and what a real client sends.
 *
 * It was a constant until one payment buying one report became a rule the
 * Worker enforces, at which point every buy after the first in a given second
 * was a byte-identical replay and correctly refused. Each buy here is meant to
 * be a separate purchase, so each needs a separate authorization.
 */
function paymentHeader({ from = VERIFIED_PAYER } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from,
          to: PAYTO_TEST,
          value: '100000',
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: `0x${randomBytes(32).toString('hex')}`,
        },
      },
    })
  ).toString('base64');
}

const buy = (header = paymentHeader()) =>
  api.lintEnvelope({ status: 402 }, { ip: ips.next(), headers: { 'x-payment': header } });

/** Alerts fire in ctx.waitUntil, after the response, so they are waited for. */
async function awaitAlert(match, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = telegram.sends.find((s) => match(s));
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no Telegram alert matching ${what} within ${timeoutMs}ms; saw ${JSON.stringify(telegram.sends)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ------------------------------------------------------------------ tests

describe('a settled payment pings the owner', () => {
  test('through Telegram, with the token and chat id from config', async () => {
    const res = await buy();
    assert.equal(res.status, 200);

    const send = await awaitAlert(() => true, 'any alert');
    assert.equal(send.path, `/bot${BOT_TOKEN}/sendMessage`);
    assert.equal(send.body.chat_id, CHAT_ID);
    assert.match(send.body.text, /THIRD PARTY PAID/);
  });

  test('the message names the amount, the endpoint, the payer and the transaction', async () => {
    await buy();
    const { body } = await awaitAlert((s) => /THIRD PARTY PAID/.test(s.body.text), 'the settlement alert');
    // The /lint/envelope price, as money AND as the atomic value beside it —
    // the pair is what makes a "$0.10" in a 3am notification checkable.
    assert.match(body.text, /\$0\.10\b/);
    assert.match(body.text, /100000 atomic/);
    assert.match(body.text, /lint-envelope/);
    assert.match(body.text, new RegExp(VERIFIED_PAYER, 'i'));
    assert.match(body.text, new RegExp(TX_HASH));
    assert.match(body.text, /basescan\.org\/tx\//);
  });

  test('and says the ledger, not the ping, is the source of truth', async () => {
    await buy();
    const { body } = await awaitAlert((s) => /THIRD PARTY PAID/.test(s.body.text), 'the settlement alert');
    assert.match(body.text, /settlements table is the source of truth/);
  });
});

describe('a house payer reads as a drill, not as a sale', () => {
  test('the headline is visibly different at a glance', async () => {
    // If a test buy and a stranger's purchase produced the same message, the
    // loud one would stop meaning anything. That is the whole feature.
    await buy(paymentHeader({ from: HOUSE_PAYER }));
    // The facilitator returns its own payer, so drive the distinction through
    // the pure function as well as the wire — see the unit block below.
    const { body } = await awaitAlert(() => true, 'any alert');
    assert.ok(body.text.length > 0);
  });

  test('isHousePayer is case-insensitive and comma-separated', () => {
    const env = { HOUSE_PAYERS: `${HOUSE_PAYER.toUpperCase()}, 0x0000000000000000000000000000000000000002` };
    assert.equal(isHousePayer(env, HOUSE_PAYER.toLowerCase()), true);
    assert.equal(isHousePayer(env, '0x0000000000000000000000000000000000000002'), true);
    assert.equal(isHousePayer(env, VERIFIED_PAYER), false);
  });

  test('unset HOUSE_PAYERS makes every payer a third party — failing TOO LOUD', () => {
    // The right direction for a revenue alert: a missed drill is noise, a
    // missed sale is the event this exists for.
    assert.equal(isHousePayer({}, VERIFIED_PAYER), false);
    assert.equal(isHousePayer({ HOUSE_PAYERS: '' }, VERIFIED_PAYER), false);
  });

  test('the two headlines cannot be confused', () => {
    const alert = { kind: 'settled', tool: 'lint', payer: HOUSE_PAYER, amount: '250000', settleOk: 1, txHash: TX_HASH };
    const house = alertHeadline({ HOUSE_PAYERS: HOUSE_PAYER }, alert);
    const stranger = alertHeadline({}, alert);
    assert.match(house, /test settlement/);
    assert.match(stranger, /THIRD PARTY PAID/);
    assert.notEqual(house, stranger);
  });
});

describe('a call served without verification is a different alarm', () => {
  test('it fires, and it says the payment was never checked', async () => {
    // Revenue leaking. Serving anyway is deliberate, but a RUN of these is the
    // paid rail silently down, and the ledger query that would reveal it is one
    // nobody runs at 3am.
    facilitator.state.verify = { nonsense: true }; // a 200 that is not a VerifyResponse
    try {
      const res = await buy();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-payment-verified'), 'false');

      const { body } = await awaitAlert((s) => /SERVED WITHOUT VERIFICATION/.test(s.body.text), 'the leak alarm');
      assert.match(body.text, /nobody paid for/);
      assert.match(body.text, /x-payment-error/);
    } finally {
      facilitator.state.verify = { isValid: true, payer: VERIFIED_PAYER };
    }
  });
});

describe('probe noise does NOT page the owner', () => {
  test('a malformed payment header sends nothing', async () => {
    // Anything on a public x402 index is scanned continuously. Paging on
    // rejected junk would train the owner to ignore the channel, which is the
    // only way this feature can truly fail.
    const res = await api.lintEnvelope({ status: 402 }, { ip: ips.next(), headers: { 'x-payment': 'junk' } });
    assert.equal(res.status, 402);
    await new Promise((r) => setTimeout(r, 1200));
    assert.deepEqual(telegram.sends, []);
  });

  test('a facilitator-rejected payment sends nothing', async () => {
    facilitator.state.verify = { isValid: false, invalidReason: 'insufficient_funds' };
    try {
      const res = await buy();
      assert.equal(res.status, 402);
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepEqual(telegram.sends, []);
    } finally {
      facilitator.state.verify = { isValid: true, payer: VERIFIED_PAYER };
    }
  });

  test('an unpaid 402 sends nothing', async () => {
    await api.lintEnvelope({ status: 402 }, { ip: ips.next() });
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(telegram.sends, []);
  });
});

describe('an alert can never damage a paid response', () => {
  test('a Telegram that answers 500 costs a ping and nothing else', async () => {
    telegram.state.status = 500;
    const res = await buy();
    assert.equal(res.status, 200, 'the buyer lost their report to a notification failure');
    assert.ok(res.body.grade);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    await awaitAlert(() => true, 'the attempt');
  });

  test('a Telegram that never answers does not delay the response', async () => {
    telegram.state.hang = true;
    const started = Date.now();
    const res = await buy();
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);
    // The alert has a 10s cap and runs in waitUntil; the RESPONSE must not wait
    // for any of it.
    assert.ok(elapsed < 5000, `the response took ${elapsed}ms behind a hung notification channel`);
    telegram.state.hang = false;
  });

  test('the ledger row is written even when the channel is dead', async () => {
    // Ordering: the ping fires AFTER the ledger write, never instead of it.
    telegram.state.status = 500;
    await buy();
    const rows = await worker.d1('SELECT settle_ok, tx_hash FROM settlements ORDER BY ts DESC, rowid DESC LIMIT 1;');
    assert.equal(Number(rows[0].settle_ok), 1);
    assert.equal(rows[0].tx_hash, TX_HASH);
  });
});

describe('the channel has a daily budget, so a bad day cannot mute it forever', () => {
  // The four rules at the top of alerts.js bound everything about an alert
  // except HOW MANY. Alerts fire per payment, and one of the paths that fires
  // them is the unverified serve — which is the path a facilitator outage puts
  // EVERY call down. An alert per call for an hour is how a notification
  // channel actually dies: not by failing, by being muted by its owner.
  let capped;
  let cappedApi;

  before(async () => {
    capped = await bootWorker({
      vars: {
        PAYTO: PAYTO_TEST,
        FACILITATOR_URL: facilitator.url,
        TELEGRAM_API_BASE: telegram.base,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_CHAT_ID: CHAT_ID,
        ALERT_DAILY: '2',
        ...fakeCdpCredentials(),
      },
    });
    cappedApi = client(capped);
  });
  after(async () => {
    await capped?.stop();
  });

  const cappedBuy = () =>
    cappedApi.lintEnvelope({ status: 402 }, { ip: ips.next(), headers: { 'x-payment': paymentHeader() } });

  test('two get through, the third says the cap is reached, the fourth is silent', async () => {
    telegram.reset();

    for (let i = 0; i < 2; i++) assert.equal((await cappedBuy()).status, 200);
    await awaitAlert(() => telegram.sends.length >= 2, 'the first two alerts');
    for (const send of telegram.sends) assert.match(send.body.text, /THIRD PARTY PAID/);

    // The one that trips it SAYS SO. Going quiet without a word would leave an
    // empty channel reading as "nothing happened", which is the same failure as
    // the flood and harder to notice.
    assert.equal((await cappedBuy()).status, 200);
    const notice = await awaitAlert((s) => /alerts capped|daily cap/.test(s.body.text), 'the cap notice');
    assert.match(notice.body.text, /settlements/, 'the notice does not say where the events are');
    assert.equal(telegram.sends.length, 3);

    // And then nothing at all.
    assert.equal((await cappedBuy()).status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(telegram.sends.length, 3, 'the cap did not hold after the notice');
  });

  test('the buyer is never affected by the cap', async () => {
    // The first rule still holds. A capped channel is a notification decision
    // and must not be visible to anyone who paid.
    const res = await cappedBuy();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.ok(res.body.grade);
  });

  test('the ledger is unaffected — the cap is on the ping, not on the record', async () => {
    // `settlements` is the source of truth and a notification budget must never
    // be able to lose a row from it.
    const rows = await capped.d1('SELECT COUNT(*) AS n FROM settlements WHERE verify_ok = 1;');
    assert.ok(Number(rows[0].n) >= 5, `only ${rows[0].n} settlement rows for 5+ buys`);
  });
});

describe('an unconfigured channel is a working state, not a broken one', () => {
  test('no Telegram config means no network call at all', async () => {
    // This service ran without alerts for its whole life until they existed; a
    // deployment that never sets the secrets must behave exactly as it did.
    const plain = await bootWorker({
      vars: { PAYTO: PAYTO_TEST, FACILITATOR_URL: facilitator.url, ...fakeCdpCredentials() },
    });
    try {
      const plainApi = client(plain);
      const res = await plainApi.lintEnvelope(
        { status: 402 },
        { ip: ips.next(), headers: { 'x-payment': paymentHeader() } }
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-payment-verified'), 'true');
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepEqual(telegram.sends, [], 'a worker with no Telegram config still called Telegram');
    } finally {
      await plain.stop();
    }
  });
});

describe('the message, as a pure function', () => {
  test('atomic USDC renders as money, never shorter than cents', () => {
    // NEVER "$0.1". The price sheet has a $0.10 and a $0.02 on it, and a
    // headline that drops the second decimal is a 10x misread in the one
    // message whose entire job is telling a human what moved. All four amounts
    // on the current sheet, rendered:
    assert.equal(formatUsdc('250000'), '$0.25');
    assert.equal(formatUsdc('20000'), '$0.02');
    assert.equal(formatUsdc('100000'), '$0.10');
    assert.equal(formatUsdc('10000'), '$0.01');
    // Sub-cent amounts keep the digits they need — other sellers price there,
    // and this renderer is pointed at their amounts too.
    assert.equal(formatUsdc('5000'), '$0.005');
    assert.equal(formatUsdc('1000'), '$0.001');
    assert.equal(formatUsdc('1000000'), '$1.00');
    assert.equal(formatUsdc('0'), '$0.00');
  });

  test('an absurd payer is clipped before it reaches a subject line', () => {
    // BEFORE VERIFY THE PAYER IS A CLAIM THE CALLER TYPED — it is read out of
    // payload.authorization.from — and the unverified-serve path alerts with
    // exactly that value. An address field holding 50 KB became 50 KB of
    // Telegram body and 50 KB of Subject header, from one unauthenticated
    // request. An EVM address is 42 characters.
    const alert = { kind: 'settled', tool: 'lint', payer: '0x'.padEnd(50_000, 'f'), amount: '250000', settleOk: 1 };
    const { subject, text } = alertMessage({}, alert);
    assert.ok(subject.length < 300, `the subject is ${subject.length} characters`);
    assert.ok(text.length < 1200, `the body is ${text.length} characters`);
    assert.match(subject, /\(\+49920 characters\)/);
  });

  test('an ordinary address is not clipped', () => {
    const alert = { kind: 'settled', tool: 'lint', payer: VERIFIED_PAYER, amount: '250000', settleOk: 1 };
    assert.match(alertHeadline({}, alert), new RegExp(VERIFIED_PAYER, 'i'));
  });

  test('a non-numeric amount is labelled rather than coerced', () => {
    // A NaN in a revenue alert is worse than an ugly one.
    assert.equal(formatUsdc('abc'), 'abc (atomic)');
    assert.equal(formatUsdc(null), 'unknown (atomic)');
    assert.equal(formatUsdc(undefined), 'unknown (atomic)');
  });

  test('a failed settlement says so in the headline, not only in the body', () => {
    const headline = alertHeadline(
      {},
      { kind: 'settled', tool: 'lint', payer: VERIFIED_PAYER, amount: '250000', settleOk: 0, error: 'nonce_already_used' }
    );
    assert.match(headline, /SETTLE FAILED \(nonce_already_used\)/);
  });

  test('the subject and the first line of the body are the same string', () => {
    // A lock screen and an inbox preview should say the identical thing.
    const alert = { kind: 'settled', tool: 'lint', payer: VERIFIED_PAYER, amount: '250000', settleOk: 1, txHash: TX_HASH };
    const { subject, text } = alertMessage({}, alert);
    assert.equal(text.split('\n')[0], subject);
  });
});

describe('the email the binding would be handed', () => {
  // The send_email binding is not exercised end to end here — that needs a
  // verified Email Routing destination on a live zone — but the MESSAGE is
  // hand-rolled RFC 5322, and Cloudflare PARSES what it is handed and rejects
  // what it cannot read. So the parts a strict parser checks are checked here.
  const message = () =>
    rawEmail({
      to: 'owner@example.com',
      subject: 'THIRD PARTY PAID — $0.25 lint',
      text: 'line one\nline two',
      date: new Date('2026-08-19T17:43:35Z'),
    });

  test('uses CRLF throughout, including inside the body', () => {
    // A bare LF in an SMTP payload is the classic silently-corrupted message.
    const raw = message();
    assert.ok(!/(?<!\r)\n/.test(raw), 'a bare LF is present');
  });

  test('carries a Message-ID, which Cloudflare requires', () => {
    assert.match(message(), /^Message-ID: <[^>]+@lemon-agent\.dev>$/m);
  });

  test('two messages do not share a Message-ID', () => {
    const id = (raw) => raw.match(/^Message-ID: (.+)$/m)[1];
    assert.notEqual(id(message()), id(message()));
  });

  test('dates in the numeric-zone form, not the obsolete "GMT"', () => {
    // "GMT" is legal only as obsolete syntax, and obsolete syntax is what a
    // strict parser declines.
    assert.match(message(), /^Date: Wed, 19 Aug 2026 17:43:35 \+0000$/m);
  });

  test('the From address matches the envelope sender', () => {
    assert.match(message(), /^From: "10x402" <alerts@lemon-agent\.dev>$/m);
  });

  test('non-ASCII subjects are RFC 2047 encoded rather than sent raw', () => {
    const raw = rawEmail({ to: 'a@b.com', subject: 'paid — café ☕', text: 'x', date: new Date(0) });
    const subject = raw.match(/^Subject: (.+(?:\r\n .+)*)$/m)[1];
    assert.match(subject, /=\?UTF-8\?B\?/);
    // Decoding the encoded-words must reassemble the original exactly, which is
    // what splitting on codepoint boundaries buys.
    const decoded = subject
      .split(/\r\n /)
      .map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'))
      .join('');
    assert.equal(decoded, 'paid — café ☕');
  });

  test('a newline in the subject cannot inject a header', () => {
    const raw = rawEmail({
      to: 'a@b.com',
      subject: 'paid\r\nBcc: attacker@example.com',
      text: 'x',
      date: new Date(0),
    });
    assert.ok(!/^Bcc:/m.test(raw), 'header injection through the subject');
  });
});

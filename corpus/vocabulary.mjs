// THE CONTROLLED VOCABULARY, and the 10x402 adapter's map into it.
//
// The corpus is tool-neutral on purpose: an expectation says "this fixture
// fails client interoperability because of url-safe base64", never "this
// fixture emits V2_B64_URLSAFE". A tool joins the corpus by writing an adapter
// from its own finding ids to these tags; nothing here names a check id, and
// nothing in corpus/fixtures.json does either.
//
// Two things are versioned together with the corpus (`corpus_version`): the tag
// list and the dimension contract. Adding a tag or changing what one means is a
// corpus version bump, because an expectation written against the old meaning
// is no longer the same claim.

/**
 * The reason tags. `fatal` marks a tag that CAN appear in an expectation —
 * i.e. some check that maps to it can reach error severity. The rest are
 * observational: a tool may report them, and they appear in the results files,
 * but they never decide a dimension and never appear in `expected`.
 */
export const REASON_TAGS = {
  // --- transport ------------------------------------------------------
  'status-not-402': { fatal: true, meaning: 'the unauthenticated request was not answered with 402' },
  'server-error': { fatal: true, meaning: 'the unpaid path answered 5xx' },
  redirect: { fatal: false, meaning: 'the 402 is reached through a redirect rather than served directly' },
  'free-tier-200': { fatal: false, meaning: 'an unauthenticated caller is served 200 — there is no challenge to interpret' },
  'content-type': { fatal: false, meaning: 'the envelope is served under a content-type that misdescribes it' },

  // --- envelope presence and encoding ---------------------------------
  'envelope-absent': { fatal: true, meaning: 'no payment envelope for the version in question' },
  'b64-urlsafe': { fatal: true, meaning: 'the header is base64url, or otherwise outside the standard base64 alphabet the cited client validates against before decoding' },
  'b64-undecodable': { fatal: true, meaning: 'the header does not base64-decode at all' },
  'envelope-not-json': { fatal: true, meaning: 'the decoded payload is not JSON' },
  'wrong-version-field': { fatal: true, meaning: 'x402Version is absent, or names a version other than the one the transport implies' },
  'version-crosstalk': { fatal: true, meaning: 'a field or shape belonging to one protocol version appears in the other' },

  // --- payment terms --------------------------------------------------
  'missing-required-field': { fatal: true, meaning: 'a field the version requires is absent' },
  'network-form': { fatal: true, meaning: 'the network identifier is in the wrong form for the version (CAIP-2 vs bare name)' },
  'network-unknown': { fatal: true, meaning: 'the network is well-formed but outside the cited client implementation’s closed enum' },
  'network-unsupported-by-provider': { fatal: false, meaning: 'the network is valid and outside a named provider’s settlement set' },
  'amount-form': { fatal: true, meaning: 'the amount is not a positive integer base-unit string' },
  'amount-below-provider-floor': { fatal: true, meaning: 'the amount is legal protocol-wise and below a named provider’s indexing minimum' },
  'payee-form': { fatal: true, meaning: 'payTo is absent, the wrong JSON type, or not an address of the network’s family' },
  'asset-form': { fatal: true, meaning: 'asset is absent, the wrong JSON type, or not an identifier of the network’s family' },
  'timeout-form': { fatal: true, meaning: 'maxTimeoutSeconds is absent or is not a positive integer NUMBER' },
  'missing-eip712-extra': { fatal: true, meaning: 'no EIP-712 domain in `extra` on a chain whose scheme signs one' },
  'scheme-unknown': { fatal: true, meaning: 'the scheme is outside the set the version admits' },
  'resource-shape': { fatal: true, meaning: 'the resource is the wrong shape for the version (object vs flat string)' },
  'resource-url': { fatal: true, meaning: 'the resource url is absent, unparseable, insecure, or does not identify the endpoint' },
  'dual-divergence': { fatal: true, meaning: 'the v1 and v2 envelopes of one dual-stack response disagree on a payment term' },

  // --- discovery ------------------------------------------------------
  'bazaar-extension-absent': { fatal: true, meaning: 'extensions.bazaar, or a required half of it, is absent' },
  'bazaar-info-schema-mismatch': { fatal: true, meaning: 'the declared `info` does not validate against the `schema` published beside it' },
  'bazaar-schema-unresolvable': { fatal: true, meaning: 'the schema depends on an external $ref a facilitator must not resolve' },
  'bazaar-input-shape': { fatal: true, meaning: 'the declared input is absent or carries no `type` discriminator' },
  'bazaar-input-method': { fatal: true, meaning: 'the declared input method disagrees with the verb the resource answers' },
  'bazaar-output-shape': { fatal: false, meaning: 'the declared output block is malformed' },
  'bazaar-output-example': { fatal: false, meaning: 'no computed output example is published' },
  'discovery-metadata': { fatal: true, meaning: 'descriptive metadata a registry reads is absent or outside its bounds' },

  // --- reported by one tool and not the other -------------------------
  'legacy-v1-header-names': { fatal: false, meaning: 'the response also exposes deprecated v1 header names' },
  'declaration-integrity': { fatal: true, meaning: 'a declaration-integrity extension is present and does not describe this declaration' },
  'extension-responses': { fatal: false, meaning: 'EXTENSION-RESPONSES was absent or undecodable' },
  truncated: { fatal: false, meaning: 'the tool stopped reading before the end of the input' },
};

export const TAGS = Object.freeze(Object.keys(REASON_TAGS));

/** One tag per check id. Mechanical on purpose — see FORMAT.md § Adapters. */
export const TENX402_TAGS = {
  HTTP_STATUS_402: 'status-not-402',
  HTTP_SERVER_ERROR: 'server-error',
  HTTP_REDIRECT: 'redirect',
  HTTP_FREE_TIER_200: 'free-tier-200',
  HTTP_CONTENT_TYPE_JSON: 'content-type',
  ENVELOPE_PRESENT: 'envelope-absent',
  V2_HEADER_PRESENT: 'envelope-absent',
  V2_B64_URLSAFE: 'b64-urlsafe',
  V2_B64_DECODE: 'b64-undecodable',
  V2_JSON: 'envelope-not-json',
  V2_VERSION: 'wrong-version-field',
  V2_ACCEPTS_NONEMPTY: 'missing-required-field',
  V2_SCHEME: 'missing-required-field',
  V2_SCHEME_KNOWN: 'scheme-unknown',
  V2_NETWORK_CAIP2: 'network-form',
  V2_NETWORK_CAIP2_STYLE: 'network-form',
  V2_NAMESPACE_KNOWN: 'network-unknown',
  V2_NETWORK_SUPPORTED: 'network-unsupported-by-provider',
  V2_AMOUNT: 'missing-required-field',
  V2_AMOUNT_ATOMIC: 'amount-form',
  V2_AMOUNT_MINIMUM: 'amount-below-provider-floor',
  V2_PAYTO: 'payee-form',
  V2_ASSET: 'asset-form',
  V2_MAX_TIMEOUT: 'timeout-form',
  V2_EXTRA_EIP712: 'missing-eip712-extra',
  V2_ACCEPTS_V1_FIELDS: 'version-crosstalk',
  V2_RESOURCE_OBJECT: 'resource-shape',
  V2_RESOURCE_URL_PARSES: 'resource-url',
  V2_RESOURCE_URL: 'resource-url',
  V2_RESOURCE_METHOD: 'discovery-metadata',
  V2_RESOURCE_DESCRIPTION: 'discovery-metadata',
  V2_RESOURCE_MIMETYPE: 'discovery-metadata',
  V2_RESOURCE_URL_MATCHES: 'resource-url',
  V2_SERVICE_NAME: 'discovery-metadata',
  V2_TAGS: 'discovery-metadata',
  V2_BAZAAR_PRESENT: 'bazaar-extension-absent',
  V2_BAZAAR_INFO: 'bazaar-extension-absent',
  V2_BAZAAR_SCHEMA: 'bazaar-extension-absent',
  V2_BAZAAR_SCHEMA_CONTENT: 'bazaar-schema-unresolvable',
  V2_BAZAAR_INFO_VALIDATES: 'bazaar-info-schema-mismatch',
  V2_BAZAAR_INPUT: 'bazaar-input-shape',
  V2_BAZAAR_INPUT_TYPE: 'bazaar-input-shape',
  V2_BAZAAR_INPUT_METHOD: 'bazaar-input-method',
  V2_BAZAAR_OUTPUT_TYPE: 'bazaar-output-shape',
  V2_BAZAAR_OUTPUT_EXAMPLE: 'bazaar-output-example',
  V1_ABSENT: 'envelope-absent',
  V1_BODY_NOT_ENVELOPE: 'envelope-absent',
  V1_BODY_PRESENT: 'envelope-absent',
  V1_BODY_JSON: 'envelope-not-json',
  V1_VERSION: 'wrong-version-field',
  V1_ACCEPTS_NONEMPTY: 'missing-required-field',
  V1_SCHEME: 'missing-required-field',
  V1_SCHEME_KNOWN: 'scheme-unknown',
  V1_MAX_AMOUNT_REQUIRED: 'missing-required-field',
  V1_AMOUNT_ATOMIC: 'amount-form',
  V1_NETWORK_NAME: 'network-form',
  V1_NETWORK_KNOWN: 'network-unknown',
  V1_RESOURCE_STRING: 'resource-shape',
  V1_PAYTO: 'payee-form',
  V1_ASSET: 'asset-form',
  V1_MIMETYPE: 'missing-required-field',
  V1_DESCRIPTION: 'missing-required-field',
  V1_MAX_TIMEOUT: 'timeout-form',
  V1_EXTRA_EIP712: 'missing-eip712-extra',
  V1_OUTPUT_SCHEMA: 'discovery-metadata',
  V1_DISCOVERABLE: 'discovery-metadata',
  DUAL_PAYTO: 'dual-divergence',
  DUAL_PRICE: 'dual-divergence',
  DUAL_NETWORK: 'dual-divergence',
  DUAL_ASSET: 'dual-divergence',
  DUAL_RESOURCE: 'dual-divergence',
  VERSION_HEADER_SAYS_V1: 'version-crosstalk',
  VERSION_BODY_SAYS_V2: 'version-crosstalk',
  ACCEPTS_TRUNCATED: 'truncated',
  FINDINGS_TRUNCATED: 'truncated',
};

/**
 * One tag per x402-doctor rule id, plus which rules cannot be evaluated
 * offline. See corpus/run-x402-doctor.mjs for how the not-evaluated set is
 * reported — it is recorded as `not-evaluated`, never as a pass.
 */
export const DOCTOR_TAGS = {
  'x402.http.challenge_status': 'status-not-402',
  'x402.headers.v2': 'envelope-absent',
  'x402.headers.legacy': 'legacy-v1-header-names',
  'x402.header.payment_required': 'b64-undecodable',
  'x402.version': 'wrong-version-field',
  'x402.requirement.scheme': 'scheme-unknown',
  'x402.requirement.network': 'network-form',
  'x402.requirement.amount': 'amount-form',
  'x402.requirement.timeout': 'timeout-form',
  'x402.requirement.asset': 'asset-form',
  'x402.requirement.payee': 'payee-form',
  'x402.resource.url': 'resource-url',
  'x402.resource.description': 'discovery-metadata',
  'x402.resource.mime_type': 'discovery-metadata',
  'x402.bazaar.missing': 'bazaar-extension-absent',
  'x402.bazaar.schema': 'bazaar-info-schema-mismatch',
  'x402.bazaar.examples': 'bazaar-info-schema-mismatch',
  'x402.bazaar.crawler_input': 'bazaar-input-shape',
  'x402.bazaar.crawler_status': 'bazaar-input-method',
  'x402.declaration_integrity.malformed': 'declaration-integrity',
  'x402.declaration_integrity.self_mismatch': 'declaration-integrity',
  'x402.declaration_integrity.resource': 'declaration-integrity',
  'x402.extensions.responses': 'extension-responses',
  'x402.network': 'status-not-402',
};

/**
 * The doctor rules that need a live registry, and therefore cannot run in an
 * offline corpus. Every one of them is recorded as `not-evaluated` rather than
 * being silently counted as a pass.
 */
export const DOCTOR_NOT_EVALUABLE_OFFLINE = new Set([
  'x402.bazaar.lookup',
  'x402.bazaar.not_found',
  'x402.bazaar.stale_metadata',
  'x402.bazaar.partial_comparison',
  'x402.declaration_integrity.catalog_malformed',
  'x402.declaration_integrity.catalog_resource',
  'x402.payment.skipped',
  'x402.payment.status',
  'x402.payment.receipt',
  'x402.payment.settled',
]);

export const DIMENSIONS = Object.freeze(['payment', 'client_interop', 'discovery']);
export const VERDICTS = Object.freeze(['pass', 'fail', 'n/a']);
/** Only a RESULTS file may carry this; an expectation may not. */
export const NOT_EVALUATED = 'not-evaluated';

/**
 * HOW STRONG A CLIENT-INTEROPERABILITY CLAIM IS. See FORMAT.md § client_interop.
 *
 * `parse` is what a schema citation can support: the cited client's decoder
 * accepts or rejects the declaration. `execute` is the stronger claim — the
 * cited client also SELECTS the offer, signs it, and issues the payment — and it
 * needs a citation into the code that does the signing or the execution, not
 * into the schema that reads the bytes.
 *
 * The corpus does not pretend to the stronger claim where it holds only the
 * weaker evidence. A fixture states its level, and the schema requires an
 * `execute`-level claim to cite client code from a signer or a payment path.
 */
export const CLIENT_INTEROP_LEVELS = Object.freeze(['parse', 'execute']);

/**
 * WHAT MAKES A DIMENSION JUDGEABLE FROM A RECORDED RESPONSE.
 *
 * A recorded corpus cannot demonstrate payability it never recorded. `payment`
 * and `client_interop` both ask about a DECLARED payment; where the recording
 * contains no challenge at all — a 200 to an anonymous caller, a redirect whose
 * target response was not captured — there is no declaration to interpret, and
 * neither `pass` nor `fail` is an honest answer. Those dimensions are `n/a`, and
 * they are excluded from the agreement statistics rather than counted as
 * agreements: two tools forced to the same non-answer have not agreed about
 * anything.
 *
 * The rule is MECHANICAL so that a third adapter reaches the same set:
 *
 *   a challenge is recorded  ⟺  status is 402
 *                             ∨  a non-empty PAYMENT-REQUIRED header is present
 *                             ∨  the body parses as an x402 envelope
 *
 * A 402 with nothing in it is therefore still judgeable, and still a failure —
 * a challenge that declares nothing is a broken challenge, not an absent one.
 * `discovery` is always judgeable: under the static-declaration reading it asks
 * whether a declaration is present and eligible, and "absent" is an answer.
 */
export function challengeRecorded(response) {
  if (response.status === 402) return true;
  const header = response.headers?.['payment-required'];
  if (typeof header === 'string' && header.trim() !== '') return true;
  try {
    const body = JSON.parse(response.body ?? '');
    return Boolean(body && typeof body === 'object' && ('x402Version' in body || Array.isArray(body.accepts)));
  } catch {
    return false;
  }
}

/** The `judgeable` map a fixture must carry, computed from the response alone. */
export function judgeableFrom(response) {
  const challenge = challengeRecorded(response);
  return { payment: challenge, client_interop: challenge, discovery: true };
}

/**
 * WHICH DIMENSIONS A FINDING MAY FAIL, given the provenance of THAT finding.
 *
 * The one rule both adapters apply, and the repair for the defect the
 * pre-publication review named: a citation that a check happens to carry is not
 * the same thing as the authority the finding rests on.
 *
 *   operative `spec` citation        → may fail `payment`
 *   operative `client-code` citation → may fail `client_interop`
 *   discovery/registry regime        → may fail `discovery`
 *   anything else — house opinion, a field report, a provider observation
 *                                    → fails NOTHING; recorded as an observation
 *
 * The last line is the whole of "provider observations should not silently
 * become protocol requirements", and it is what the previous version got wrong:
 * a finding citing no authority was routed to `payment`, "the strict side",
 * which is exactly the mechanism by which a house rule became a normative
 * payment verdict.
 */
export function dimensionsForProvenance(provenance, { registry = false } = {}) {
  if (registry) return { fails: ['discovery'], speaks: ['discovery'] };
  const kinds = new Set(provenance.map((s) => s.kind));
  const fails = [];
  if (kinds.has('spec')) fails.push('payment');
  if (kinds.has('client-code')) fails.push('client_interop');
  // A finding with no normative authority still SPEAKS to the dimension whose
  // subject it is about — it is recorded there, as an observation, and decides
  // nothing.
  const speaks = fails.length ? fails : ['payment', 'client_interop'];
  return { fails, speaks };
}

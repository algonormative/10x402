// A REAL x402 402, captured once from a live production seller.
//
// Fetched 2026-08-19T17:43:35Z with a single unauthenticated POST to
// https://toolshed.lemon-agent.dev/convert/md-html — free, because a 402 is what
// an unpaid call gets. It is a dual-stack seller (v1 envelope in the body, v2
// envelope in a PAYMENT-REQUIRED header) run by the same house as this service,
// and it is the closest thing available to a known-good sample.
//
// It has three jobs, and all three matter:
//
//   1. THE POSITIVE CONTROL. A linter that only ever meets its own constructed
//      fixtures is a linter that has never met a real response — real headers,
//      real encodings, real ordering. If this stops grading A, either a live
//      seller regressed or, far more likely, this engine did. Ground the
//      measurement on a known-good before trusting any negative verdict it
//      hands a stranger.
//   2. The worked output example published in THIS service’s own v2 envelope
//      (extensions.bazaar.info.output.example) is computed by linting it — so
//      the example in the envelope is a real run rather than a hand-written
//      hope that drifts the first time the report shape changes.
//   3. It documents, in one artefact, what a conformant dual-stack 402
//      actually looks like on the wire.
//
// FROZEN ON PURPOSE. Refreshing it on every run would make the suite depend on
// a third party staying healthy, which is the opposite of what a control is
// for. If the upstream envelope changes, capture a NEW file and keep this one.

export const POSITIVE_CONTROL = {
  "captured": "2026-08-19T17:43:35Z",
  "url": "https://toolshed.lemon-agent.dev/convert/md-html",
  "method": "POST",
  "status": 402,
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "payment-required": "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly90b29sc2hlZC5sZW1vbi1hZ2VudC5kZXYvY29udmVydC9tZC1odG1sIiwibWV0aG9kIjoiUE9TVCIsImRlc2NyaXB0aW9uIjoiTWFya2Rvd24gdG8gSFRNTCBjb252ZXJzaW9uIiwibWltZVR5cGUiOiJ0ZXh0L2h0bWwiLCJ0YWdzIjpbIng0MDIiLCJjb252ZXJzaW9uIl0sInNlcnZpY2VOYW1lIjoiVG9vbHNoZWQifSwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJhbW91bnQiOiIxMDAwIiwiYXNzZXQiOiIweDgzMzU4OWZDRDZlRGI2RTA4ZjRjN0MzMkQ0ZjcxYjU0YmRBMDI5MTMiLCJwYXlUbyI6IjB4MGFkYzdhZGFjN2JiYWZmZmZiZDczNTA1NzExZTQyMzc4YzRmOWY5ZSIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTRCBDb2luIiwidmVyc2lvbiI6IjIifX1dLCJleHRlbnNpb25zIjp7ImJhemFhciI6eyJpbmZvIjp7ImlucHV0Ijp7InR5cGUiOiJodHRwIiwibWV0aG9kIjoiUE9TVCIsImJvZHlUeXBlIjoidGV4dCIsImJvZHkiOiIjIFRpdGxlXG5cblNvbWUgKipib2xkKiogdGV4dC5cbiJ9LCJvdXRwdXQiOnsidHlwZSI6InRleHQiLCJmb3JtYXQiOiJ0ZXh0L2h0bWwiLCJleGFtcGxlIjoiPGgxPlRpdGxlPC9oMT5cbjxwPlNvbWUgPHN0cm9uZz5ib2xkPC9zdHJvbmc+IHRleHQuPC9wPlxuIn19LCJzY2hlbWEiOnsiJHNjaGVtYSI6Imh0dHBzOi8vanNvbi1zY2hlbWEub3JnL2RyYWZ0LzIwMjAtMTIvc2NoZW1hIiwidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsiaW5wdXQiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsidHlwZSI6eyJ0eXBlIjoic3RyaW5nIiwiY29uc3QiOiJodHRwIn0sIm1ldGhvZCI6eyJ0eXBlIjoic3RyaW5nIiwiY29uc3QiOiJQT1NUIn0sImJvZHlUeXBlIjp7InR5cGUiOiJzdHJpbmciLCJjb25zdCI6InRleHQifSwiYm9keSI6eyJ0eXBlIjoic3RyaW5nIiwiZGVzY3JpcHRpb24iOiJ0aGUgcmF3IE1hcmtkb3duIGZpbGUgYXMgdGhlIHJlcXVlc3QgYm9keSwgdXAgdG8gMjU2IEtCIiwibWF4TGVuZ3RoIjoyNjIxNDR9fSwicmVxdWlyZWQiOlsidHlwZSIsIm1ldGhvZCIsImJvZHlUeXBlIiwiYm9keSJdLCJhZGRpdGlvbmFsUHJvcGVydGllcyI6ZmFsc2V9LCJvdXRwdXQiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsidHlwZSI6eyJ0eXBlIjoic3RyaW5nIiwiY29uc3QiOiJ0ZXh0In0sImZvcm1hdCI6eyJ0eXBlIjoic3RyaW5nIiwiY29uc3QiOiJ0ZXh0L2h0bWwiLCJkZXNjcmlwdGlvbiI6InRoZSBjb252ZXJ0ZWQgSFRNTCBmaWxlIGFzIHRoZSByZXNwb25zZSBib2R5ICh0ZXh0L2h0bWwpIn0sImV4YW1wbGUiOnsidHlwZSI6InN0cmluZyIsImRlc2NyaXB0aW9uIjoidGhlIHNhbXBsZSByZXF1ZXN0IGJvZHkgYWJvdmUsIGNvbnZlcnRlZCDigJQgd2hhdCBhIHRoZSBjb252ZXJ0ZWQgSFRNTCBmaWxlIGFzIHRoZSByZXNwb25zZSBib2R5ICh0ZXh0L2h0bWwpIGxvb2tzIGxpa2UifX0sInJlcXVpcmVkIjpbInR5cGUiLCJmb3JtYXQiXSwiYWRkaXRpb25hbFByb3BlcnRpZXMiOmZhbHNlfX0sInJlcXVpcmVkIjpbImlucHV0Il19fX19"
  },
  "body": "{\"x402Version\":1,\"error\":\"X-PAYMENT header is required\",\"accepts\":[{\"scheme\":\"exact\",\"network\":\"base\",\"maxAmountRequired\":\"1000\",\"resource\":\"https://toolshed.lemon-agent.dev/convert/md-html\",\"description\":\"Markdown to HTML conversion\",\"mimeType\":\"text/html\",\"payTo\":\"0x0adc7adac7bbaffffbd73505711e42378c4f9f9e\",\"maxTimeoutSeconds\":60,\"asset\":\"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\",\"extra\":{\"name\":\"USD Coin\",\"version\":\"2\"},\"outputSchema\":{\"input\":{\"type\":\"http\",\"method\":\"POST\",\"discoverable\":true,\"bodyType\":\"text\",\"description\":\"the raw Markdown file as the request body, up to 256 KB\"},\"output\":{\"type\":\"string\",\"description\":\"the converted HTML file as the response body (text/html)\"}}}]}\n"
};

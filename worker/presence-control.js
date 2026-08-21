// A REAL presence observation, captured from the live registries on
// 2026-08-21 and frozen — the presence analogue of
// worker/positive-control.js. It exists so the output example published in
// /presence's own 402 envelope is the real assembly code run over real
// observations (see runSample in worker/envelope.js), with no network call at
// build time and nothing typed by hand. The subject is this service's own
// /lint/one resource, which makes the sample a statement we can stand behind:
// on the capture date it was in the Bazaar catalog (15060 resources total),
// registered on x402scan, and had settled on-chain.
//
// Recapture (dev machine, never from tests): the capture script lives in the
// session scratchpad; any equivalent three reads and a re-trim reproduce this.
export const PRESENCE_CONTROL = {
  "captured": "2026-08-21T16:04:41.730Z",
  "target": {
    "url": "https://10x402.com/lint/one",
    "payTo": [
      "0x885E7BEF433eb78F5976b28A7c10739c98DB11E5"
    ]
  },
  "bazaar": {
    "ok": true,
    "total": 15060,
    "matches": [
      {
        "resource": "https://10x402.com/lint/one",
        "x402Version": 2,
        "lastUpdated": "2026-08-20T04:20:41.394Z",
        "payTo": "0x885E7BEF433eb78F5976b28A7c10739c98DB11E5"
      }
    ],
    "payToMatches": 4
  },
  "scan": {
    "ok": true,
    "match": {
      "resource": "https://10x402.com/lint/one",
      "method": "POST",
      "x402Version": 2,
      "lastUpdated": "2026-08-20T04:21:14.065Z"
    }
  },
  "chain": {
    "ok": true,
    "window": "all transfers",
    "transfers": 4,
    "latest": {
      "value": "100000",
      "tokenSymbol": "USDC",
      "timeStamp": "1787199643",
      "hash": "0x3321c354d365c5ddd1494edda84bb2ccd0191303638f9dfb280b8c7303c7b675",
      "from": "0x632ff2f904cc6ab6d741a42014c4c483f328e92f",
      "to": "0x885e7bef433eb78f5976b28a7c10739c98db11e5",
      "contractAddress": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    }
  }
};

# TxLens

**Deterministic transaction intent and risk analysis for Arc Mainnet.**

TxLens is an Arc-native transaction inspection service for humans, applications, and autonomous agents. It explains what a transaction is trying to do before signing, or reconstructs and analyzes an already executed transaction from its hash.

The project is designed around a simple principle:

> **Decode what can be proven, label what cannot, and never confuse ABI decoding with a safety guarantee.**

TxLens runs exclusively on **Arc Mainnet (chain ID 5042)** and supports two paid public access rails — **Direct USDC** and **Gateway Nanopayments** — plus isolated Bearer-authenticated fulfillment endpoints for the **Mahshar API marketplace**.

---

## Table of contents

- [Why TxLens exists](#why-txlens-exists)
- [What TxLens does](#what-txlens-does)
- [Network and asset configuration](#network-and-asset-configuration)
- [Products and pricing](#products-and-pricing)
- [High-level architecture](#high-level-architecture)
- [Transaction Analyzer](#transaction-analyzer)
- [Transaction Lookup](#transaction-lookup)
- [Deterministic analysis](#deterministic-analysis)
- [Verified ABI enrichment](#verified-abi-enrichment)
- [Arc Memo support](#arc-memo-support)
- [Receipt and event decoding](#receipt-and-event-decoding)
- [Risk model](#risk-model)
- [Direct USDC payment rail](#direct-usdc-payment-rail)
- [Gateway Nanopayments](#gateway-nanopayments)
- [Gateway wallet UX](#gateway-wallet-ux)
- [Mahshar marketplace fulfillment](#mahshar-marketplace-fulfillment)
- [API reference](#api-reference)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Production deployment](#production-deployment)
- [Testing](#testing)
- [Security model](#security-model)
- [Operational boundaries](#operational-boundaries)
- [Repository structure](#repository-structure)
- [Technology stack](#technology-stack)
- [Design principles](#design-principles)

---

## Why TxLens exists

Raw EVM transactions are difficult to reason about.

A wallet may show a hexadecimal calldata blob, a destination address, and a value, while the real action hidden inside that calldata could be:

- a token transfer,
- an ERC-20 approval,
- an unlimited approval,
- an NFT operator approval,
- a delegated transfer using an existing allowance,
- a contract ownership transfer,
- a call to a verified but unfamiliar protocol contract,
- a system-contract action such as Arc Memo,
- or something TxLens cannot safely identify.

That gap is especially important for autonomous agents. An agent can construct and sign transactions much faster than a human can manually inspect them, which makes deterministic, machine-readable transaction explanation valuable infrastructure.

TxLens therefore provides a narrow service:

1. accept an Arc Mainnet transaction description or transaction hash;
2. deterministically identify known high-value behaviors;
3. enrich unknown calls only from trusted contract-specific metadata;
4. decode receipt events where authoritative ABI metadata exists;
5. return structured intent, confidence, warnings, and decoded data;
6. preserve `unknown` whenever the available evidence is insufficient.

TxLens is **not** a generic smart-contract auditor, exploit detector, or guarantee that a decoded contract is safe.

---

## What TxLens does

TxLens currently exposes two products.

### 1. Transaction Analyzer

Analyzes a transaction **before it is signed or submitted**.

Input:

```json
{
  "chainId": 5042,
  "to": "0x...",
  "data": "0x...",
  "value": "0"
}
```

Typical output:

```json
{
  "action": "token_approval",
  "summary": "This transaction approves ...",
  "risk": "high",
  "confidence": 0.98,
  "warnings": [
    {
      "type": "unlimited_approval",
      "severity": "high",
      "message": "Unlimited token spending permission detected..."
    }
  ],
  "decoded": {
    "spender": "0x...",
    "amount": "unlimited (max uint256)",
    "isUnlimited": true
  }
}
```

### 2. Transaction Lookup

Analyzes a transaction that already exists on Arc Mainnet.

Input:

```json
{
  "chainId": 5042,
  "txHash": "0x..."
}
```

TxLens retrieves the transaction and receipt through Arc RPC, then returns:

- transaction metadata,
- execution status,
- block number,
- target,
- value,
- calldata,
- deterministic intent,
- verified ABI enrichment when available,
- decoded receipt events when available,
- risk context and warnings.

---

## Network and asset configuration

TxLens production is intentionally single-network.

| Item | Value |
|---|---|
| Network | Arc Mainnet |
| EVM chain ID | `5042` |
| Native USDC | `0x3600000000000000000000000000000000000000` |
| Arc RPC fallback | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| Production service | `https://txlens-api-production.up.railway.app` |

Requests for other chains are rejected.

This restriction is deliberate. TxLens payment verification, contract metadata assumptions, system-contract ABIs, and transaction lookup semantics are all scoped to Arc Mainnet.

---

## Products and pricing

| Product | Direct endpoint | Gateway endpoint | Price |
|---|---|---|---:|
| Transaction Analyzer | `POST /api/analyze` | `POST /api/analyze/gateway` | **0.002 USDC** |
| Transaction Lookup | `POST /api/lookup-tx` | `POST /api/lookup-tx/gateway` | **0.003 USDC** |

TxLens deliberately exposes the same analysis capability through two payment modes:

- **Direct USDC** is the default for occasional or one-time calls.
- **Gateway Nanopayments** are optimized for repeated use and agent/API workloads.

The analysis result is independent of payment mode.

---

## High-level architecture

```text
                         ┌─────────────────────────────┐
                         │          TxLens UI          │
                         │ React + Vite + wagmi/viem  │
                         └──────────────┬──────────────┘
                                        │
                 ┌──────────────────────┼──────────────────────┐
                 │                      │                      │
                 ▼                      ▼                      ▼
        Direct USDC API        Gateway Nanopayments    Mahshar Fulfillment
        /api/analyze            /api/analyze/gateway   /api/internal/mahshar/...
        /api/lookup-tx          /api/lookup-tx/gateway
                 │                      │                      │
                 └──────────────────────┼──────────────────────┘
                                        ▼
                              Shared fulfillment logic
                                        │
                          ┌─────────────┴─────────────┐
                          │                           │
                          ▼                           ▼
                 Deterministic analyzer        Arc RPC lookup
                          │                           │
                          └─────────────┬─────────────┘
                                        ▼
                            Verified ABI enrichment
                                        │
                   ┌────────────────────┼────────────────────┐
                   │                    │                    │
                   ▼                    ▼                    ▼
             Arc system ABI      Verified explorer ABI   Receipt logs
             exact-address       / declared proxy only   per emitter
                   │                    │                    │
                   └────────────────────┴────────────────────┘
                                        ▼
                              Structured TxLens result
```

All public and marketplace routes converge on the same core analysis path.

There is no weaker "marketplace analyzer" or separate lightweight implementation.

---

## Transaction Analyzer

The Analyzer is intended for pre-signing inspection.

### Request

```http
POST /api/analyze
Content-Type: application/json
```

```json
{
  "chainId": 5042,
  "to": "0x3600000000000000000000000000000000000000",
  "data": "0x",
  "value": "0"
}
```

Fields:

| Field | Type | Required | Description |
|---|---|---:|---|
| `chainId` | number | yes | Must be `5042` |
| `to` | string | yes | EVM target address |
| `data` | hex string | no | Transaction calldata |
| `value` | decimal string | no | Native value in wei-like base units |

The analyzer does not broadcast the transaction.

It only explains the supplied transaction description.

### Example response

```json
{
  "action": "empty_transaction",
  "summary": "This transaction sends no value and carries no calldata. It may trigger a receive() or fallback() function on the target contract.",
  "risk": "low",
  "confidence": 0.9,
  "warnings": [],
  "decoded": {}
}
```

---

## Transaction Lookup

Lookup accepts a transaction hash and reconstructs the transaction from Arc Mainnet.

### Request

```http
POST /api/lookup-tx
Content-Type: application/json
```

```json
{
  "chainId": 5042,
  "txHash": "0xa3efb83ad9ac4f2164d36b2579104cb7fb19c986cd623206b27387330e33fa33"
}
```

The service performs:

```text
txHash
  ↓
eth_getTransactionByHash
  ↓
eth_getTransactionReceipt
  ↓
normalize native value
  ↓
deterministic transaction analysis
  ↓
verified ABI enrichment when applicable
  ↓
receipt-event decoding by emitting contract
  ↓
structured response
```

The returned `transaction` object includes:

- hash,
- from,
- to,
- decimal value,
- hexadecimal value,
- input/calldata,
- execution status,
- block number,
- network name,
- Arc explorer URL.

Lookup never requires the caller to manually supply transaction calldata or receipt logs.

---

## Deterministic analysis

TxLens always begins with deterministic logic.

Recognized selectors include important ERC-20, ERC-721/ERC-1155-style and administrative actions such as:

- `approve(address,uint256)`
- `setApprovalForAll(address,bool)`
- `transfer(address,uint256)`
- `transferFrom(address,address,uint256)`
- `transferOwnership(address)`
- `safeTransferFrom(...)`
- selected common read/write selectors

Examples of deterministic classifications include:

### Native transfer

A transaction with no calldata and non-zero native value:

```json
{
  "action": "native_transfer",
  "risk": "low",
  "confidence": 0.99
}
```

### ERC-20 approval

TxLens extracts:

- spender,
- amount,
- whether the approval is max uint256.

Unlimited approvals receive a high-severity warning.

### Operator approval

`setApprovalForAll(..., true)` is classified as high risk because it delegates broad transfer authority.

### Delegated transfer

`transferFrom` is decoded into:

- from,
- to,
- amount.

### Contract ownership transfer

`transferOwnership` is classified as high risk because it changes administrative control.

### Malformed calldata

If a known selector is present but the argument encoding is incomplete or malformed, TxLens does **not** pretend the call decoded successfully.

It returns an explicit `malformed_calldata` result.

### Unknown selector

If deterministic logic cannot recognize a selector, TxLens returns `unknown_function_call` first.

Only then may verified ABI enrichment attempt a contract-specific decode.

---

## Verified ABI enrichment

ABI enrichment is designed as an additional evidence layer, not a replacement for deterministic analysis.

The enrichment path activates primarily when the deterministic analyzer returns an unknown contract call.

### Trust model

TxLens accepts ABI metadata only from contract-specific trusted sources.

Supported trust classes include:

- authoritative Arc system-contract ABI metadata,
- verified contract ABI metadata,
- verified implementation ABI metadata when an explorer explicitly identifies a proxy and implementation.

TxLens does **not** treat a generic 4-byte signature database as proof of contract intent.

A selector collision is possible across unrelated functions. Contract-specific ABI metadata is therefore required for authoritative enrichment.

### Proxy handling

Proxy resolution is conservative.

TxLens follows an implementation only when authoritative contract metadata explicitly marks the target as a proxy and supplies a valid implementation address.

It does not guess proxy slots or invent implementation relationships.

### ABI decoding

When a trusted ABI matches the exact target contract:

- the function selector is matched against ABI functions,
- overloaded signatures are handled individually,
- argument encoding must successfully decode,
- named ABI inputs become named JSON fields,
- bigint values are serialized safely as strings.

A successful enrichment result resembles:

```json
{
  "action": "verified_contract_call",
  "function": "memo(address,bytes,bytes32,bytes)",
  "risk": "unknown",
  "confidence": 0.95,
  "warnings": [
    {
      "type": "abi_decoding_not_safety",
      "severity": "low",
      "message": "The calldata was decoded from contract-specific authoritative metadata. This identifies intent but is not a security endorsement."
    }
  ],
  "decoded": {
    "selector": "0xc3b2c4f8",
    "signature": "memo(address,bytes,bytes32,bytes)",
    "arguments": {}
  },
  "enrichment": {
    "source": "arc_system_contract_abi",
    "contract": "0x...",
    "implementation": null
  }
}
```

The important rule is:

> **Verified ABI means "we can explain this encoded call with authoritative metadata." It does not mean "this transaction is safe."**

Therefore enriched contract calls intentionally preserve `risk: "unknown"` unless deterministic evidence supports a stronger classification.

### Enrichment bounds

Production enrichment is deliberately bounded to avoid turning metadata lookup into an unbounded dependency:

- default enrichment deadline: **3 seconds**
- receipt logs considered: **100 max**
- unique log-emitting contracts resolved: **6 max**
- serialized arrays: bounded
- serialized object keys: bounded
- serialized strings: bounded
- metadata cache: bounded in memory
- positive and negative metadata caching are used
- explorer failures fall back to the deterministic result

General verified-contract explorer enrichment uses `ETHERSCAN_API_KEY` when configured.

Authoritative built-in Arc system metadata remains available independently where implemented.

---

## Arc Memo support

TxLens contains authoritative support for Arc's Memo system contract.

A previously unknown selector such as:

```text
0xc3b2c4f8
```

can be resolved against the exact Arc Memo system-contract ABI as:

```solidity
memo(address target, bytes data, bytes32 memoId, bytes memoData)
```

TxLens can then explain:

- the target address,
- forwarded calldata,
- memo identifier,
- opaque memo bytes,
- receipt events emitted by Memo and downstream contracts when their ABIs are trusted.

TxLens intentionally does **not** invent application semantics for arbitrary `memoData`.

Unless an authoritative schema exists, memo data remains opaque bytes.

This is an example of the project's general philosophy: decode structure aggressively, infer meaning conservatively.

---

## Receipt and event decoding

Lookup also analyzes transaction receipts.

For each bounded receipt log:

1. identify the emitting contract;
2. resolve trusted ABI metadata for that exact emitter;
3. match `topic0` against ABI events;
4. decode indexed and non-indexed event arguments;
5. serialize decoded values into bounded JSON.

A decoded event may include:

```json
{
  "address": "0x...",
  "topic0": "0x...",
  "decoded": true,
  "event": "Transfer",
  "signature": "Transfer(address,address,uint256)",
  "arguments": {
    "from": "0x...",
    "to": "0x...",
    "value": "0"
  },
  "source": "arc_system_contract_abi"
}
```

If an event cannot be authoritatively decoded, it remains present as an unknown log rather than being dropped or guessed.

---

## Risk model

TxLens currently exposes:

```text
low
medium
high
unknown
```

Risk is driven by deterministic transaction semantics.

Examples:

| Behavior | Typical risk |
|---|---|
| Simple transfer | low |
| Empty transaction | low |
| Very large approval | medium |
| Unlimited ERC-20 approval | high |
| `setApprovalForAll(true)` | high |
| Ownership transfer | high |
| Unknown / ABI-enriched arbitrary contract call | unknown |

The risk model is intentionally not a reputation score.

TxLens does not currently claim:

- that a contract is malicious,
- that a contract is safe,
- that a decoded action will have a specific economic outcome,
- that verified source code eliminates contract risk,
- that a low-risk semantic action cannot be used in a malicious broader workflow.

`confidence` describes confidence in the **interpretation**, not trust in the counterparty.

---

## Direct USDC payment rail

Direct USDC is the default public payment path for one-time or occasional usage.

It uses Arc native USDC and **EIP-3009 `transferWithAuthorization`** rather than asking the user for an unlimited token approval.

### Why EIP-3009

The user signs an authorization for an exact transfer instead of granting TxLens a standing allowance.

That gives TxLens a cleaner one-request / one-payment relationship.

### Direct payment sequence

```text
Client
  │
  │ POST /api/direct/quote
  │ { route, payer, body }
  ▼
TxLens
  │
  │ signed request-bound quote
  ▼
Client
  │
  │ signs EIP-3009 TransferWithAuthorization
  │ for exact USDC amount
  ▼
Arc native USDC
  │
  │ transferWithAuthorization(...)
  ▼
Client
  │
  │ POST paid API request
  │ X-TxLens-Payment-Quote
  │ X-TxLens-Payment-Tx
  ▼
TxLens
  │
  │ independently verifies on-chain payment
  ▼
Fulfillment
```

### Prices in atomic USDC

The server binds fixed atomic amounts to the requested product:

- Analyzer: **0.002 USDC**
- Lookup: **0.003 USDC**

### Quote binding

A direct-payment quote is bound to:

- route,
- normalized payer,
- seller,
- exact amount,
- canonical request body,
- authorization timing/nonce metadata.

Canonical request-body hashing prevents JSON key-order differences from producing ambiguous payment binding.

### Arc USDC EIP-712 domain

Arc native USDC uses:

```text
name: USDC
version: 2
chainId: 5042
verifyingContract: 0x3600000000000000000000000000000000000000
```

This domain must be exact.

### Signature normalization

USDC authorization signatures are normalized so `v` is accepted in the form expected by the token contract.

### Pre-broadcast simulation

The client simulates the exact `transferWithAuthorization` call before broadcasting it.

This surfaces signature/domain/argument failures before the user unnecessarily submits a failing transaction.

### Server-side payment verification

TxLens does not trust a client saying "I paid."

The server verifies the actual Arc transaction and checks payment properties including:

- payer,
- seller,
- amount,
- authorization nonce/window,
- USDC contract,
- receipt success,
- block timestamp.

A confirmed payment proof is tied to the same quoted route/body.

It cannot be reused to purchase a different request.

### Unpaid response

A request without valid payment proof returns HTTP `402` with the required payment metadata.

---

## Gateway Nanopayments

TxLens also supports Circle Gateway Nanopayments through `@circle-fin/x402-batching`.

Gateway routes:

```text
POST /api/analyze/gateway
POST /api/lookup-tx/gateway
```

Prices are the same as Direct USDC:

- Analyzer: **$0.002**
- Lookup: **$0.003**

Gateway is intended for repeated calls where a user or agent prefers to fund a Gateway balance and pay through batched/gasless nanopayment infrastructure instead of creating a standalone on-chain transfer for every request.

### Network restriction

Gateway payment requirements are scoped to:

```text
eip155:5042
```

and Arc native USDC.

The frontend rejects payment requirements that attempt to switch to another network or asset.

### Payment middleware

The server's Gateway middleware protects only the Gateway routes.

Direct endpoints remain Direct USDC.

The two payment rails are intentionally independent.

---

## Gateway wallet UX

The TxLens frontend exposes Gateway-oriented wallet controls alongside the normal Arc wallet experience.

The interface can show:

- Arc wallet USDC balance,
- Gateway balance,
- deposit flow,
- withdrawal initiation,
- eligible withdrawal completion,
- payment mode selection.

Gateway withdrawal is a two-step process and respects the protocol's activation delay before completion.

The browser wallet integration uses the user's EIP-1193 wallet provider.

Private keys are never embedded in or supplied to the TxLens frontend.

---

## Mahshar marketplace fulfillment

TxLens is also designed to be sold through **Mahshar**, an API marketplace where Mahshar handles buyer payment and then forwards the authorized upstream request.

The important architectural rule is:

> A Mahshar buyer must not pay TxLens a second time after Mahshar already settled the marketplace purchase.

Therefore TxLens exposes two isolated server-to-server fulfillment endpoints.

### Analyzer fulfillment

```http
POST /api/internal/mahshar/analyze
Authorization: Bearer <MAHSHAR_ANALYZE_API_TOKEN>
```

### Lookup fulfillment

```http
POST /api/internal/mahshar/lookup-tx
Authorization: Bearer <MAHSHAR_LOOKUP_API_TOKEN>
```

### Separate credentials

The two products deliberately use separate tokens.

- Analyzer accepts only `MAHSHAR_ANALYZE_API_TOKEN`.
- Lookup accepts only `MAHSHAR_LOOKUP_API_TOKEN`.
- Analyze credentials cannot authorize Lookup.
- Lookup credentials cannot authorize Analyze.
- Missing credentials fail closed.
- Unconfigured credentials fail closed.
- Wrong credentials return a generic `401 Unauthorized`.

The old single-token model is not used by production code.

### Request flow through Mahshar

```text
Human / Developer / Agent
          │
          │ buys TxLens API call
          ▼
       Mahshar
          │
          │ x402 payment + marketplace accounting
          │ seller credential kept server-side
          ▼
 Mahshar proxy injects
 Authorization: Bearer <listing credential>
          │
          ▼
 TxLens internal fulfillment endpoint
          │
          │ same production analyzer / lookup logic
          ▼
       Mahshar
          │
          ▼
      Buyer result
```

The buyer never receives the Bearer credential.

### Mahshar listing model

TxLens is intended to appear as two independent products:

#### TxLens Transaction Analyzer

- category: Utility
- method: POST
- price: 0.002 USDC / call
- auth: Bearer
- upstream:
  `/api/internal/mahshar/analyze`

#### TxLens Transaction Lookup

- category: Utility
- method: POST
- price: 0.003 USDC / call
- auth: Bearer
- upstream:
  `/api/internal/mahshar/lookup-tx`

Mahshar is therefore an additional distribution/payment channel, not a different TxLens analyzer.

---

## API reference

### Health

```http
GET /health
```

Example:

```json
{
  "status": "ok",
  "service": "txlens-api",
  "chain": "Arc Mainnet",
  "chainId": 5042
}
```

### Create Direct payment quote

```http
POST /api/direct/quote
Content-Type: application/json
```

Body:

```json
{
  "route": "analyze",
  "payer": "0x...",
  "body": {
    "chainId": 5042,
    "to": "0x...",
    "data": "0x...",
    "value": "0"
  }
}
```

Valid `route` values:

- `analyze`
- `lookup`

### Direct Analyzer

```http
POST /api/analyze
X-TxLens-Payment-Quote: <quote>
X-TxLens-Payment-Tx: <confirmed Arc tx hash>
Content-Type: application/json
```

### Direct Lookup

```http
POST /api/lookup-tx
X-TxLens-Payment-Quote: <quote>
X-TxLens-Payment-Tx: <confirmed Arc tx hash>
Content-Type: application/json
```

### Gateway Analyzer

```http
POST /api/analyze/gateway
```

Protected by Gateway x402 middleware.

### Gateway Lookup

```http
POST /api/lookup-tx/gateway
```

Protected by Gateway x402 middleware.

### Mahshar Analyzer

```http
POST /api/internal/mahshar/analyze
Authorization: Bearer <analyze-token>
Content-Type: application/json
```

### Mahshar Lookup

```http
POST /api/internal/mahshar/lookup-tx
Authorization: Bearer <lookup-token>
Content-Type: application/json
```

---

## Environment variables

Production expects server-side configuration.

```dotenv
SELLER_WALLET_ADDRESS=0xYOUR_EVM_SELLER_ADDRESS
DIRECT_PAYMENT_SECRET=<strong-server-secret>
ETHERSCAN_API_KEY=
MAHSHAR_ANALYZE_API_TOKEN=
MAHSHAR_LOOKUP_API_TOKEN=
PORT=3001
```

### `SELLER_WALLET_ADDRESS`

Required.

Must be a valid EVM address.

Public Direct and Gateway payments are configured to pay this seller.

### `DIRECT_PAYMENT_SECRET`

Required in production by the direct-payment quote/verification system.

Use a strong secret of at least 32 characters.

It must remain server-side.

Do not expose it to the browser, commit it to Git, print it in logs, or reuse it as a marketplace credential.

### `ETHERSCAN_API_KEY`

Optional for general verified-contract ABI enrichment.

Without it, built-in authoritative Arc system metadata can still support system contracts implemented by TxLens, while broader explorer-backed ABI enrichment may be unavailable.

### `MAHSHAR_ANALYZE_API_TOKEN`

Secret Bearer credential accepted only by:

```text
POST /api/internal/mahshar/analyze
```

### `MAHSHAR_LOOKUP_API_TOKEN`

Secret Bearer credential accepted only by:

```text
POST /api/internal/mahshar/lookup-tx
```

### `PORT`

Server port.

Defaults to `3001`.

### Optional RPC proxy variables

The server can use an RPC proxy when these variables are supplied and Arc Mainnet is enabled in the configured chain list:

- `RPC_PROXY_BASE_URL`
- `RPC_PROXY_TOKEN`
- `RPC_PROXY_CHAINS`

Otherwise it falls back to the public Arc Mainnet RPC.

---

## Local development

TxLens uses Bun.

The repository declares:

```text
bun@1.2.22
```

### Install

```bash
bun install
```

### Configure environment

Copy the example file and provide the required secrets locally.

```bash
cp .env.example .env
```

Do not commit `.env`.

### Frontend dev server

```bash
bun run dev
```

### API / production-style server

```bash
bun run start
```

or:

```bash
bun run start:prod
```

### Build frontend

```bash
bun run build
```

### Typecheck

```bash
bun run typecheck
```

### Tests

```bash
bun test
```

---

## Production deployment

The production TxLens service is currently deployed on Railway:

```text
https://txlens-api-production.up.railway.app
```

Production deployment must provide server-side secrets through Railway environment variables.

Do not move secret material into Vite client variables.

The Express server serves both:

- API routes,
- built frontend assets from `dist`.

A deployment should be considered healthy only after:

1. build succeeds;
2. server starts;
3. `GET /health` returns 200;
4. unpaid Direct endpoints return 402 rather than bypassing payment;
5. unpaid Gateway endpoints return their x402 payment requirement;
6. Mahshar endpoints return 401 without credentials;
7. valid route-specific Mahshar credentials authorize only their own endpoint;
8. Arc-only chain validation remains active.

---

## Testing

The current test suite covers the critical trust boundaries.

### ABI enrichment tests

`tests/analyzer-enrichment.test.ts`

Covers behavior such as:

- contract-specific ABI decoding,
- authoritative Arc system metadata,
- unknown-call fallback,
- event decoding,
- proxy constraints,
- bounded enrichment behavior.

### Direct payment tests

`tests/direct-payment.test.ts`

Covers the Direct USDC payment flow and request/payment binding.

### Gateway tests

`tests/gateway-selection.test.ts`

Covers Arc-specific Gateway payment requirement selection.

### Mahshar endpoint tests

`tests/mahshar-endpoints.test.ts`

Covers:

- missing Bearer credentials,
- wrong credentials,
- valid Analyze token,
- valid Lookup token,
- Analyze token rejected by Lookup,
- Lookup token rejected by Analyze,
- unconfigured env fail-closed behavior,
- Arc Mainnet restriction,
- preservation of analysis/enrichment behavior,
- continued payment protection on public Direct and Gateway routes.

At the Mahshar route-specific authentication release, the full suite passed:

```text
45 tests passed
0 failed
102 assertions
```

The same release also passed:

- TypeScript typecheck,
- frontend production build,
- server production bundle,
- secret scan,
- dependency/lockfile drift checks.

---

## Security model

TxLens is intentionally conservative around the boundaries that can cause financial or interpretation errors.

### 1. No client-trusted payment claims

Direct fulfillment requires independently verified Arc payment evidence.

### 2. Request-bound payment proof

A payment quote is tied to the product and canonical request payload.

### 3. Exact USDC authorization

Direct payment uses an exact EIP-3009 authorization rather than a standing unlimited allowance.

### 4. Arc-only validation

Production rejects non-5042 analysis and lookup requests.

### 5. Gateway network/asset restriction

Gateway requirements are restricted to Arc Mainnet and Arc native USDC.

### 6. Trusted ABI only

Unknown selectors are not upgraded into "known" actions through an untrusted global signature guess.

### 7. ABI != safety

Verified contract metadata improves decoding confidence, but never acts as a security endorsement.

### 8. Conservative proxy resolution

Implementation ABIs are followed only when authoritative metadata explicitly declares the proxy relationship.

### 9. Bounded external enrichment

Explorer/RPC metadata enrichment is time- and size-bounded and may safely fall back.

### 10. Secret isolation

Server secrets include:

- Direct payment signing/verification secret,
- Mahshar Analyze token,
- Mahshar Lookup token,
- optional explorer API credential.

They must remain server-side.

### 11. Route-specific marketplace credentials

Compromise of one Mahshar listing credential does not automatically authorize the other product.

### 12. Generic unauthorized response

Mahshar authentication does not reveal whether the credential was missing, wrong, or unconfigured beyond a generic 401.

---

## Operational boundaries

TxLens should be understood as an **intent decoder and transaction risk-context service**.

It is not currently:

- a contract audit service,
- a simulation engine for every possible state transition,
- a malware oracle,
- an economic-risk oracle,
- a wallet-drainer blacklist,
- a universal multichain analyzer,
- a proof that a verified contract is trustworthy,
- a substitute for protocol-specific risk analysis.

Its job is to make transaction semantics more legible while preserving uncertainty.

---

## Repository structure

```text
txlens/
├── .env.example
├── bun.lock
├── package.json
├── server.ts
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── config.ts
│   ├── components/
│   │   └── ... UI including TxLens transaction/payment experience
│   ├── hooks/
│   ├── payments/
│   │   └── ... Direct USDC / Gateway client payment logic
│   └── server/
│       ├── analyzer.ts
│       ├── abiEnrichment.ts
│       ├── contractMetadata.ts
│       ├── directPayment.ts
│       └── ...
└── tests/
    ├── analyzer-enrichment.test.ts
    ├── direct-payment.test.ts
    ├── gateway-selection.test.ts
    └── mahshar-endpoints.test.ts
```

### `server.ts`

Primary Express application.

Responsibilities include:

- API routing,
- Arc RPC lookup,
- Direct USDC payment enforcement,
- Gateway middleware,
- Mahshar Bearer auth,
- shared Analyzer / Lookup fulfillment,
- static frontend hosting,
- health endpoint.

### `src/server/analyzer.ts`

Deterministic transaction analysis.

### `src/server/abiEnrichment.ts`

Contract-specific verified ABI and event enrichment.

### `src/server/contractMetadata.ts`

Trusted contract metadata resolution, including authoritative system metadata and explorer-backed verified ABI paths.

### `src/server/directPayment.ts`

Direct EIP-3009 payment quote creation and on-chain verification.

---

## Technology stack

Core runtime and application stack:

- **Bun**
- **TypeScript**
- **Express 5**
- **React 18**
- **Vite**
- **Tailwind CSS**
- **viem**
- **wagmi**
- **ConnectKit**
- **Circle App Kit**
- **Circle x402 batching / Gateway**
- **Arc Mainnet**
- **Arc native USDC**
- **Railway**

The project intentionally keeps transaction interpretation in ordinary deterministic server code rather than requiring an LLM to decide transaction meaning.

That makes TxLens suitable for use by other AI agents without forcing one probabilistic model to trust another probabilistic model's unsupported interpretation.

---

## Design principles

### Deterministic first

Known transaction structures should be decoded with deterministic code.

### Evidence over guessing

When data is insufficient, return `unknown`.

### Contract-specific metadata over selector folklore

A 4-byte selector alone is not authoritative contract semantics.

### Payment and fulfillment are separate concerns

Direct, Gateway, and Mahshar routes all converge on the same analysis implementation after their respective payment/authentication gates.

### One chain, deeply supported

TxLens currently prefers strong Arc-specific correctness over superficial multichain coverage.

### No double charging

Marketplace fulfillment routes bypass TxLens public payment middleware because Mahshar already handles buyer settlement.

### No hidden downgrade

Mahshar fulfillment uses the same analysis/enrichment path as public TxLens.

### Safety language must match evidence

Decoding a call is not the same as approving it.

---

## Current production status

The current production architecture includes:

- Arc Mainnet-only transaction analysis,
- pre-sign Transaction Analyzer,
- executed Transaction Lookup,
- Direct Arc USDC EIP-3009 payments,
- Circle Gateway Nanopayments,
- Gateway wallet funding / withdrawal UX,
- deterministic approval/transfer/admin-risk detection,
- authoritative Arc Memo decoding,
- verified contract ABI enrichment,
- receipt-event enrichment,
- separate Mahshar Analyzer and Lookup fulfillment credentials,
- Railway production deployment.

For exact implementation behavior, the current `main` branch is the source of truth.

---

## For AI agents reading this repository

If you are an AI coding or auditing agent, preserve these invariants unless the project owner explicitly requests a change:

1. **Arc Mainnet remains chain ID 5042.**
2. **Do not silently add multichain behavior.**
3. **Direct and Gateway payment rails are separate and both intentional.**
4. **Direct USDC uses request-bound EIP-3009 payment verification.**
5. **Do not replace exact authorization with unlimited approval.**
6. **Do not treat ABI verification as a safety guarantee.**
7. **Do not use generic selector databases as authoritative contract semantics.**
8. **Do not remove deterministic fallback behavior when enrichment fails.**
9. **Do not expose Mahshar credentials to frontend code.**
10. **Do not merge the two Mahshar Bearer credentials.**
11. **Do not add payment middleware to Mahshar internal fulfillment routes.**
12. **Do not bypass payment on public Direct or Gateway endpoints.**
13. **Do not invent semantics for opaque Memo payloads.**
14. **Preserve bounded external metadata/RPC behavior.**
15. **Run the full test suite, typecheck, frontend build, and server bundle checks before production changes.**

The safest workflow is to inspect the current implementation first, modify the smallest necessary surface, preserve existing trust boundaries, and verify public payment routes plus internal marketplace auth after every related change.

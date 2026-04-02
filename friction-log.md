# Day 3 Friction Log - Agent Autonomy Challenge

## Project: ChainPay - Cross-Chain Payment Links on ICP

**Agent:** Claude Code (Opus 4.6)
**Skills Used:** icp-cli, motoko, canister-security, icrc-ledger, ckbtc, internet-identity, stable-memory, https-outcalls, multi-canister

---

### Friction Point 1: `icp new` project creation location
**Time lost:** ~3 min
**Category:** icp-cli

When running `icp new --subfolder hello-world ... --silent chain-pay` from a parent directory, the project was created as a sibling directory rather than in the target day3 directory. Had to manually copy files. The `--init` flag requires a NAME argument which is confusing. The `--destination` flag exists but isn't obvious.

**Suggestion:** Better docs on `--init` vs `--destination` for existing directories.

---

### Friction Point 2: mo:core API differences from mo:base
**Time lost:** ~8 min
**Category:** motoko skill

The agent's initial code used `Debug.trap()`, `List.pushFront()`, `Text.toPattern()`, and `Float` without import - all incorrect for mo:core. Key differences:

- `Debug.trap()` doesn't exist -> use `Runtime.trap()`
- `List.pushFront()` doesn't exist -> use `List.add()` (appends to end)
- `Text.toPattern()` doesn't exist -> use `#text "prefix"` pattern literal
- `Float` needs explicit import from `mo:core/Float`
- `continue label` syntax uses different patterns in Motoko

The motoko skill document mentions some of these but not all. Had to read the mo:core source files directly to discover the correct APIs.

**Suggestion:** The motoko skill should include a complete mo:core cheat sheet showing the most common operations (add to list, trap, text matching, etc.)

---

### Friction Point 3: Motoko char literal matching
**Time lost:** ~2 min
**Category:** motoko

`case '"' { ... }` causes a syntax error in Motoko switch expressions. Had to use `Char.toNat32(c) == 34` as a workaround. This is a minor language ergonomics issue.

---

### Friction Point 4: icp-cli identity vs dfx identity mismatch
**Time lost:** ~5 min
**Category:** icp-cli

icp-cli and dfx maintain separate identity stores. The default identity in icp-cli (`clanker-paste`) was different from dfx's default identity. This meant:
- ICP balance showed 0.86 ICP in dfx but 0 in icp-cli
- Cycles minting failed because icp-cli was looking at the wrong account
- Had to import the dfx default identity PEM file into icp-cli

**Suggestion:** icp-cli should either share the dfx identity store or clearly document this divergence during migration.

---

### Friction Point 5: Canister creation minimum cycles
**Time lost:** ~3 min
**Category:** icp-cli, cycles-management

`icp deploy -e ic` defaults to requesting 2T cycles per canister. When balance was only ~1T, deployment failed. The error message was clear, but:
- `--cycles 300B` also failed because the minimum to CREATE a canister is 500B
- Even with 1T per canister, INSTALL failed because the canister had insufficient cycles for the WASM installation
- Had to use `icp canister top-up` which uses `--amount` flag (not `--cycles` like `icp deploy`)

Inconsistent flag naming across subcommands is confusing.

**Suggestion:** Standardize `--cycles` vs `--amount` across all icp-cli subcommands. Consider auto-topping up canisters during deploy if needed.

---

### Friction Point 6: @icp-sdk/auth version and import path
**Time lost:** ~3 min
**Category:** internet-identity skill

The template project uses `@icp-sdk/core@~5.2.0` but `@icp-sdk/auth` only has version `5.0.0` (no 5.2.0). The import path for `AuthClient` is `@icp-sdk/auth/client`, not `@icp-sdk/auth`. The internet-identity skill document references `@icp-sdk/auth` (>= 5.0.0) but doesn't specify the subpath import.

**Suggestion:** Update the internet-identity skill to show the exact import: `import { AuthClient } from "@icp-sdk/auth/client"`.

---

### Friction Point 7: @icp-sdk/bindgen generates wrapper types that differ from raw Candid types
**Time lost:** ~5 min
**Category:** icp-cli (bindgen)

The generated `backend.ts` wrapper creates:
- `enum PaymentMethod { icp = "icp", ckbtc = "ckbtc" }` instead of `{ icp: null } | { ckbtc: null }`
- `Option<T>` with `__kind__: "Some" | "None"` instead of `[] | [T]`
- `PaymentLinkInfo | null` instead of `[] | [PaymentLinkInfo]`

This means you can't use the raw Candid types from `declarations/backend.did.d.ts` with the wrapper. You must use the wrapper's own types. The PICjs tests (which use the raw Candid layer) had to use different types than the frontend.

Not necessarily wrong, but the type incompatibility between `declarations/*.did.d.ts` and the wrapper `backend.ts` caused confusing TypeScript errors.

**Suggestion:** Document that `@icp-sdk/bindgen` wraps Candid types into more ergonomic forms and that the two type systems aren't interchangeable.

---

### What Went Well

1. **icp-cli build/deploy pipeline** - Once configured, `icp build` and `icp deploy` worked flawlessly. The recipe system is much cleaner than raw dfx config.

2. **PICjs testing** - Setting up tests was straightforward once I knew the pattern. 31 tests all pass. The `@dfinity/pic` API is well-designed.

3. **Motoko persistent actor** - The `persistent actor` pattern is excellent. No `pre_upgrade`/`post_upgrade` hooks needed. All state automatically survives upgrades.

4. **`icp cycles mint`** - Converting ICP to cycles was simple and fast once using the right identity.

5. **HTTPS outcalls** - The transform function pattern for consensus was well-documented in the skill and worked on first try.

6. **Canister environment variables** - The `PUBLIC_CANISTER_ID:backend` injection and `ic_env` cookie pattern works well for frontend-backend wiring.

7. **HTTP interface** - Serving HTML payment pages from `http_request` on the backend canister is a powerful ICP-unique capability.

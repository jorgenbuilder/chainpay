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

### Friction Point 3: @icp-sdk/auth version and import path

**Time lost:** ~3 min
**Category:** internet-identity skill

The template project uses `@icp-sdk/core@~5.2.0` but `@icp-sdk/auth` only has version `5.0.0` (no 5.2.0). The import path for `AuthClient` is `@icp-sdk/auth/client`, not `@icp-sdk/auth`. The internet-identity skill document references `@icp-sdk/auth` (>= 5.0.0) but doesn't specify the subpath import.

**Suggestion:** Update the internet-identity skill to show the exact import: `import { AuthClient } from "@icp-sdk/auth/client"`.

---

### Friction Point 4: ICRC-1 subaccount byte ordering caused lost funds

**Time lost:** ~20 min
**Category:** icrc-ledger, agent error

The agent implemented subaccount derivation by left-aligning the link ID bytes: `[0x31, 0, 0, ..., 0]` (link ID "1" = ASCII 0x31 at byte 0). The ICRC-1 trimmed account format then displayed this as `...checksum.31`.

When the user sent ICP via `dfx ledger transfer --to-subaccount 00000...0031`, dfx interpreted the hex as right-aligned (0x31 at byte 31), creating a mismatch. The canister checked the left-aligned subaccount and found 0 balance. The 1 ICP was stranded in the wrong subaccount.

Root cause: The ICRC-1 trimmed subaccount format is inherently ambiguous about byte position. A trimmed value of `31` could mean byte 0 = 0x31 (left-aligned) or byte 31 = 0x31 (right-aligned). dfx and most wallets interpret it right-aligned.

Fixed by right-aligning subaccount bytes and adding a controller rescue function. Funds were recovered.

**Suggestion:** The icrc-ledger skill should explicitly document subaccount byte ordering conventions and warn about the left-align trap.

---

### Friction Point 5: No wallet functionality = unusable payment flow

**Time lost:** ~15 min
**Category:** UX / agent oversight

The agent built a payment confirmation flow that forwarded received funds to the creator's principal, but provided no way for users to view their balance or withdraw funds within the app. When the rescue function sent funds to the link creator's II principal, those funds were effectively inaccessible since the app had no wallet view.

This is an agent UX blind spot: it built the "happy path" (create link -> receive payment) without considering what happens after funds arrive. A payment app without wallet management is incomplete.

Fixed by adding a Wallet view with balance display and send functionality.

---

### Friction Point 6: Initial payment address display was raw technical data

**Time lost:** ~10 min
**Category:** UX / agent oversight

The first version of "Show Payment Address" displayed raw `Owner=52253-7yaaa... Subaccount=0x31000...` text, which is completely unusable for end users. Had to redesign into a proper 3-step flow with ICRC-1 formatted addresses and click-to-copy.

The agent's default instinct is to show debug-level data. Payment UX must be self-explanatory and wallet-compatible.

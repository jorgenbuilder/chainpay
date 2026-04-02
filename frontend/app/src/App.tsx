import { useState, useEffect, useCallback } from "react";
import { createActor, PaymentMethod, type PaymentLinkInfo, type Account, type Result } from "./backend/api/backend";
import { getCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { AuthClient } from "@icp-sdk/auth/client";
import { Principal } from "@icp-sdk/core/principal";
import type { Identity } from "@icp-sdk/core/agent";

// Environment
const canisterEnv = getCanisterEnv<{
  readonly "PUBLIC_CANISTER_ID:backend": string;
  readonly IC_ROOT_KEY?: string;
}>();
const backendId = canisterEnv?.["PUBLIC_CANISTER_ID:backend"] ?? "";
const rootKey = canisterEnv?.IC_ROOT_KEY;

// II URL: mainnet by default, local if dev
const II_URL = import.meta.env.DEV
  ? "http://id.ai.localhost:8000"
  : "https://id.ai";

function makeActor(identity?: Identity) {
  return createActor(backendId, {
    agentOptions: {
      identity,
      rootKey: rootKey ? rootKey : undefined,
      shouldFetchRootKey: import.meta.env.DEV && !rootKey,
    },
  });
}

type View = "home" | "create" | "dashboard" | "pay" | "wallet";

function formatAmount(amount: bigint, method: string): string {
  const whole = amount / 100_000_000n;
  const frac = amount % 100_000_000n;
  const symbol = method === "icp" ? "ICP" : "ckBTC";
  if (frac === 0n) return `${whole} ${symbol}`;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}.${fracStr} ${symbol}`;
}

function getMethod(link: PaymentLinkInfo): string {
  return link.method === PaymentMethod.icp ? "icp" : "ckbtc";
}

// CRC-32 for ICRC-1 account checksum
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatIcrc1Account(owner: string, subaccount?: Uint8Array): string {
  const sub = subaccount ?? new Uint8Array(32);
  if (sub.every((b) => b === 0)) return owner;

  const principalBytes = Principal.fromText(owner).toUint8Array();
  const checksumInput = new Uint8Array(principalBytes.length + 32);
  checksumInput.set(principalBytes, 0);
  checksumInput.set(sub, principalBytes.length);
  const checksum = crc32(checksumInput);
  const checksumHex = checksum.toString(16).padStart(8, "0");

  let lastNonZero = 31;
  while (lastNonZero > 0 && sub[lastNonZero] === 0) lastNonZero--;
  const trimmed = sub.slice(0, lastNonZero + 1);
  const subHex = Array.from(trimmed)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${owner}-${checksumHex}.${subHex}`;
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [principal, setPrincipal] = useState("");
  const [myLinks, setMyLinks] = useState<PaymentLinkInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [payLinkId, setPayLinkId] = useState("");
  const [payLinkInfo, setPayLinkInfo] = useState<PaymentLinkInfo | null>(null);
  const [paymentAddress, setPaymentAddress] = useState("");
  const [payStep, setPayStep] = useState<"info" | "address" | "confirm">("info");
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [usdEstimate, setUsdEstimate] = useState("");
  const [icpBalance, setIcpBalance] = useState<bigint | null>(null);
  const [ckbtcBalance, setCkbtcBalance] = useState<bigint | null>(null);
  const [withdrawTo, setWithdrawTo] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawMethod, setWithdrawMethod] = useState<"icp" | "ckbtc">("icp");

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"icp" | "ckbtc">("icp");
  const [expiryDays, setExpiryDays] = useState("");

  // Init auth client
  useEffect(() => {
    AuthClient.create().then(async (client: AuthClient) => {
      setAuthClient(client);
      const authed = await client.isAuthenticated();
      if (authed) {
        setIsAuthenticated(true);
        const identity = client.getIdentity();
        setPrincipal(identity.getPrincipal().toText());
      }
    });

    // Check URL params for pay view
    const params = new URLSearchParams(window.location.search);
    const payId = params.get("pay");
    if (payId) {
      setPayLinkId(payId);
      setView("pay");
    }
  }, []);

  // Load pay link info and USD price
  useEffect(() => {
    if (view === "pay" && payLinkId) {
      const actor = makeActor();
      actor.getLink(payLinkId).then((result: PaymentLinkInfo | null) => {
        if (result) {
          setPayLinkInfo(result);
          // Fetch USD price
          actor.getUsdPrices().then((prices) => {
            const m = getMethod(result);
            const price = m === "icp" ? prices.icpUsd : prices.btcUsd;
            const amountFloat = Number(result.amount) / 100_000_000;
            const usd = (amountFloat * price).toFixed(2);
            setUsdEstimate(`~$${usd} USD`);
          }).catch(() => {
            // Price feed may fail, that's OK
          });
        }
      });
    }
  }, [view, payLinkId]);

  const login = useCallback(async () => {
    if (!authClient) return;
    await authClient.login({
      identityProvider: II_URL,
      maxTimeToLive: BigInt(8 * 60 * 60 * 1_000_000_000), // 8 hours
      onSuccess: () => {
        setIsAuthenticated(true);
        const identity = authClient.getIdentity();
        setPrincipal(identity.getPrincipal().toText());
      },
      onError: (err?: string) => {
        setError(`Login failed: ${err}`);
      },
    });
  }, [authClient]);

  const logout = useCallback(async () => {
    if (!authClient) return;
    await authClient.logout();
    setIsAuthenticated(false);
    setPrincipal("");
    setMyLinks([]);
    setView("home");
  }, [authClient]);

  const loadMyLinks = useCallback(async () => {
    if (!authClient || !isAuthenticated) return;
    setLoading(true);
    try {
      const actor = makeActor(authClient.getIdentity());
      const links = await actor.myLinks();
      setMyLinks(links as PaymentLinkInfo[]);
    } catch (e: unknown) {
      setError((e as Error).message || "Failed to load links");
    } finally {
      setLoading(false);
    }
  }, [authClient, isAuthenticated]);

  const loadBalances = useCallback(async () => {
    if (!authClient || !isAuthenticated) return;
    try {
      const actor = makeActor(authClient.getIdentity());
      const [icp, btc] = await Promise.all([
        actor.myBalance(Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai")),
        actor.myBalance(Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai")),
      ]);
      setIcpBalance(icp);
      setCkbtcBalance(btc);
    } catch {
      // balance check can fail, non-critical
    }
  }, [authClient, isAuthenticated]);

  useEffect(() => {
    if (view === "dashboard" && isAuthenticated) {
      loadMyLinks();
    }
    if (view === "wallet" && isAuthenticated) {
      loadBalances();
    }
  }, [view, isAuthenticated, loadMyLinks, loadBalances]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authClient || !isAuthenticated) return;
    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const actor = makeActor(authClient.getIdentity());
      const amountE8s = BigInt(Math.round(parseFloat(amount) * 100_000_000));

      const linkId = await actor.createLink({
        title,
        description,
        amount: amountE8s,
        method: method === "icp" ? PaymentMethod.icp : PaymentMethod.ckbtc,
        expiresAt: expiryDays
          ? BigInt(Date.now()) * 1_000_000n +
            BigInt(parseInt(expiryDays)) * 86_400_000_000_000n
          : undefined,
      });

      setSuccess(`Payment link created! ID: ${linkId}`);
      setTitle("");
      setDescription("");
      setAmount("");
      setExpiryDays("");
    } catch (e: unknown) {
      setError((e as Error).message || "Failed to create link");
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivate = async (linkId: string) => {
    if (!authClient) return;
    const actor = makeActor(authClient.getIdentity());
    await actor.deactivateLink(linkId);
    loadMyLinks();
  };

  const handleReactivate = async (linkId: string) => {
    if (!authClient) return;
    const actor = makeActor(authClient.getIdentity());
    await actor.reactivateLink(linkId);
    loadMyLinks();
  };

  return (
    <div className="min-h-screen bg-bg">
      {/* Navigation */}
      <nav className="border-b border-white/10 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <button
            onClick={() => setView("home")}
            className="text-2xl font-bold text-brand cursor-pointer bg-transparent border-none"
          >
            ChainPay
          </button>
          <div className="flex items-center gap-4">
            {isAuthenticated ? (
              <>
                <button
                  onClick={() => setView("create")}
                  className="px-4 py-2 bg-brand text-black font-semibold rounded-lg hover:bg-brand-dark transition cursor-pointer"
                >
                  Create Link
                </button>
                <button
                  onClick={() => setView("dashboard")}
                  className="px-4 py-2 bg-surface-light text-white rounded-lg hover:bg-surface transition cursor-pointer"
                >
                  Dashboard
                </button>
                <button
                  onClick={() => setView("wallet")}
                  className="px-4 py-2 bg-surface-light text-white rounded-lg hover:bg-surface transition cursor-pointer"
                >
                  Wallet
                </button>
                <span className="text-xs text-gray-500 max-w-32 truncate">
                  {principal}
                </span>
                <button
                  onClick={logout}
                  className="text-sm text-gray-400 hover:text-white cursor-pointer bg-transparent border-none"
                >
                  Logout
                </button>
              </>
            ) : (
              <button
                onClick={login}
                className="px-4 py-2 bg-brand text-black font-semibold rounded-lg hover:bg-brand-dark transition cursor-pointer"
              >
                Sign in with Internet Identity
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Messages */}
      {error && (
        <div className="max-w-3xl mx-auto mt-4 px-4 py-3 bg-red-500/20 border border-red-500/30 rounded-lg text-red-300">
          {error}
          <button
            onClick={() => setError("")}
            className="ml-2 text-red-400 hover:text-red-200 cursor-pointer bg-transparent border-none"
          >
            x
          </button>
        </div>
      )}
      {success && (
        <div className="max-w-3xl mx-auto mt-4 px-4 py-3 bg-green-500/20 border border-green-500/30 rounded-lg text-green-300">
          {success}
          <button
            onClick={() => setSuccess("")}
            className="ml-2 text-green-400 hover:text-green-200 cursor-pointer bg-transparent border-none"
          >
            x
          </button>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* Home View */}
        {view === "home" && (
          <div className="text-center py-16">
            <h1 className="text-5xl font-bold mb-4">
              <span className="text-brand">Cross-Chain</span> Payment Links
            </h1>
            <p className="text-xl text-gray-400 mb-8 max-w-xl mx-auto">
              Create shareable payment links that accept ICP and ckBTC.
              Powered by the Internet Computer.
            </p>
            <div className="flex gap-4 justify-center mb-12">
              {isAuthenticated ? (
                <button
                  onClick={() => setView("create")}
                  className="px-6 py-3 bg-brand text-black font-bold rounded-xl text-lg hover:bg-brand-dark transition cursor-pointer"
                >
                  Create Payment Link
                </button>
              ) : (
                <button
                  onClick={login}
                  className="px-6 py-3 bg-brand text-black font-bold rounded-xl text-lg hover:bg-brand-dark transition cursor-pointer"
                >
                  Get Started with Internet Identity
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto">
              <FeatureCard
                icon="&#9889;"
                title="Instant Settlement"
                desc="Payments settle in 1-2 seconds on the Internet Computer."
              />
              <FeatureCard
                icon="&#x1f517;"
                title="Multi-Chain"
                desc="Accept ICP tokens and ckBTC (chain-key Bitcoin) natively."
              />
              <FeatureCard
                icon="&#x1f512;"
                title="No Middleman"
                desc="Smart contract handles everything. No custodian, no fees beyond gas."
              />
            </div>
          </div>
        )}

        {/* Create View */}
        {view === "create" && isAuthenticated && (
          <div className="max-w-lg mx-auto">
            <h2 className="text-2xl font-bold mb-6">Create Payment Link</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <Field label="Title *">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Freelance Invoice #42"
                  maxLength={100}
                  required
                  className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                />
              </Field>

              <Field label="Description">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                  maxLength={500}
                  rows={2}
                  className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none"
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Amount *">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="1.0"
                    step="0.00000001"
                    min="0.00000001"
                    required
                    className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                  />
                </Field>
                <Field label="Currency">
                  <select
                    value={method}
                    onChange={(e) =>
                      setMethod(e.target.value as "icp" | "ckbtc")
                    }
                    className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white focus:outline-none focus:border-brand"
                  >
                    <option value="icp">ICP</option>
                    <option value="ckbtc">ckBTC</option>
                  </select>
                </Field>
              </div>

              <Field label="Expires in (days, optional)">
                <input
                  type="number"
                  value={expiryDays}
                  onChange={(e) => setExpiryDays(e.target.value)}
                  placeholder="30"
                  min="1"
                  max="365"
                  className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                />
              </Field>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark transition disabled:opacity-50 cursor-pointer"
              >
                {loading ? "Creating..." : "Create Payment Link"}
              </button>
            </form>
          </div>
        )}

        {/* Dashboard View */}
        {view === "dashboard" && isAuthenticated && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold">My Payment Links</h2>
              <button
                onClick={loadMyLinks}
                disabled={loading}
                className="px-4 py-2 bg-surface-light rounded-lg text-sm hover:bg-surface transition cursor-pointer"
              >
                {loading ? "Loading..." : "Refresh"}
              </button>
            </div>

            {myLinks.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p className="mb-4">No payment links yet.</p>
                <button
                  onClick={() => setView("create")}
                  className="px-4 py-2 bg-brand text-black font-semibold rounded-lg cursor-pointer"
                >
                  Create Your First Link
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {myLinks.map((link) => (
                  <LinkCard
                    key={link.id}
                    link={link}
                    onCopy={() => {
                      navigator.clipboard.writeText(
                        `${window.location.origin}/?pay=${link.id}`
                      );
                      setSuccess("Link copied to clipboard!");
                    }}
                    onDeactivate={() => handleDeactivate(link.id)}
                    onReactivate={() => handleReactivate(link.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Pay View */}
        {view === "pay" && (
          <div className="max-w-md mx-auto text-center py-8">
            {payLinkInfo ? (
              <div className="bg-surface rounded-2xl p-8 border border-white/5">
                <span
                  className={`text-xs px-3 py-1 rounded-full inline-block mb-4 ${
                    payLinkInfo.active
                      ? "bg-brand/20 text-brand"
                      : "bg-gray-500/20 text-gray-400"
                  }`}
                >
                  {payLinkInfo.active ? "Active" : "Inactive"}
                </span>
                <h2 className="text-2xl font-bold mb-2">
                  {payLinkInfo.title}
                </h2>
                {payLinkInfo.description && (
                  <p className="text-gray-400 mb-4">
                    {payLinkInfo.description}
                  </p>
                )}
                <div className="text-4xl font-bold text-brand mb-1">
                  {formatAmount(payLinkInfo.amount, getMethod(payLinkInfo))}
                </div>
                <div className="text-sm text-gray-500 mb-1">
                  Pay with {getMethod(payLinkInfo) === "icp" ? "ICP" : "ckBTC"}
                </div>
                {usdEstimate && (
                  <div className="text-sm text-gray-600 mb-6">{usdEstimate}</div>
                )}
                {!usdEstimate && <div className="mb-6" />}

                {payLinkInfo.active ? (
                  <div className="space-y-4">
                    {/* Step 1: Show payment instructions */}
                    {payStep === "info" && (
                      <>
                        <div className="bg-bg rounded-xl p-4 text-left space-y-3">
                          <h3 className="font-semibold text-sm">How to pay</h3>
                          <div className="flex gap-3 items-start">
                            <span className="bg-brand/20 text-brand rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">1</span>
                            <p className="text-sm text-gray-300">Get the payment address below</p>
                          </div>
                          <div className="flex gap-3 items-start">
                            <span className="bg-brand/20 text-brand rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">2</span>
                            <p className="text-sm text-gray-300">
                              Send exactly <span className="text-brand font-bold">{formatAmount(payLinkInfo.amount, getMethod(payLinkInfo))}</span> from your wallet (NNS, Plug, or CLI)
                            </p>
                          </div>
                          <div className="flex gap-3 items-start">
                            <span className="bg-brand/20 text-brand rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">3</span>
                            <p className="text-sm text-gray-300">Come back here and confirm your payment</p>
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              const actor = makeActor(authClient?.getIdentity());
                              const addr = await actor.getPaymentAddress(payLinkId);
                              if (addr) {
                                const account = addr as Account;
                                const ownerText = account.owner.toText();
                                const sub = account.subaccount
                                  ? new Uint8Array(account.subaccount)
                                  : undefined;
                                const formatted = formatIcrc1Account(ownerText, sub);
                                setPaymentAddress(formatted);
                                setPayStep("address");
                              }
                            } catch (e: unknown) {
                              setError((e as Error).message);
                            }
                          }}
                          className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark transition cursor-pointer"
                        >
                          Get Payment Address
                        </button>
                      </>
                    )}

                    {/* Step 2: Show copyable address */}
                    {payStep === "address" && paymentAddress && (
                      <>
                        <div className="bg-bg rounded-xl p-4 text-left">
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="font-semibold text-sm">Send {getMethod(payLinkInfo) === "icp" ? "ICP" : "ckBTC"} to this address</h3>
                          </div>
                          <div
                            className="bg-surface-light rounded-lg p-3 font-mono text-xs break-all text-brand cursor-pointer hover:bg-white/5 transition relative group"
                            onClick={() => {
                              navigator.clipboard.writeText(paymentAddress);
                              setSuccess("Address copied to clipboard!");
                            }}
                          >
                            {paymentAddress}
                            <span className="absolute top-2 right-2 text-gray-500 text-xs opacity-0 group-hover:opacity-100 transition">
                              click to copy
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-2">
                            This is an ICRC-1 account address. Paste it into your wallet's "Send" field.
                          </p>
                        </div>

                        <div className="bg-bg rounded-xl p-4 text-left">
                          <h3 className="font-semibold text-sm mb-2">Amount to send</h3>
                          <div
                            className="bg-surface-light rounded-lg p-3 font-mono text-lg text-brand cursor-pointer hover:bg-white/5 transition"
                            onClick={() => {
                              const whole = payLinkInfo!.amount / 100_000_000n;
                              const frac = payLinkInfo!.amount % 100_000_000n;
                              const numStr = frac === 0n
                                ? whole.toString()
                                : `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
                              navigator.clipboard.writeText(numStr);
                              setSuccess("Amount copied!");
                            }}
                          >
                            {formatAmount(payLinkInfo.amount, getMethod(payLinkInfo))}
                          </div>
                          <p className="text-xs text-gray-500 mt-1">Click to copy amount</p>
                        </div>

                        <button
                          onClick={() => setPayStep("confirm")}
                          className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark transition cursor-pointer"
                        >
                          I've Sent the Payment
                        </button>
                        <button
                          onClick={() => setPayStep("info")}
                          className="w-full py-2 text-gray-500 text-sm hover:text-white transition cursor-pointer bg-transparent border-none"
                        >
                          Back
                        </button>
                      </>
                    )}

                    {/* Step 3: Confirm payment */}
                    {payStep === "confirm" && (
                      <>
                        <div className="bg-bg rounded-xl p-4 text-left">
                          <h3 className="font-semibold text-sm mb-2">Verify your payment</h3>
                          <p className="text-sm text-gray-400">
                            Click below to check if your payment has arrived. The canister will verify the balance on-chain.
                          </p>
                        </div>
                        {isAuthenticated ? (
                          <button
                            disabled={confirmLoading}
                            onClick={async () => {
                              setConfirmLoading(true);
                              setError("");
                              try {
                                const actor = makeActor(authClient!.getIdentity());
                                const result = await actor.confirmPayment({
                                  linkId: payLinkId,
                                  blockIndex: 0n,
                                });
                                const r = result as Result;
                                if ("ok" in r) {
                                  setSuccess(`Payment confirmed! Payment ID: ${r.ok}`);
                                  setPayStep("info");
                                } else if ("err" in r) {
                                  setError(r.err);
                                }
                              } catch (e: unknown) {
                                setError((e as Error).message);
                              } finally {
                                setConfirmLoading(false);
                              }
                            }}
                            className="w-full py-3 bg-green-500 text-black font-bold rounded-lg hover:bg-green-400 transition disabled:opacity-50 cursor-pointer"
                          >
                            {confirmLoading ? "Checking..." : "Check Payment"}
                          </button>
                        ) : (
                          <button
                            onClick={login}
                            className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark transition cursor-pointer"
                          >
                            Sign in to Confirm Payment
                          </button>
                        )}
                        <button
                          onClick={() => setPayStep("address")}
                          className="w-full py-2 text-gray-500 text-sm hover:text-white transition cursor-pointer bg-transparent border-none"
                        >
                          Back to Address
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="py-4 bg-gray-500/10 rounded-lg text-gray-500">
                    This payment link is no longer active.
                  </div>
                )}

                <div className="mt-6 pt-4 border-t border-white/5 text-xs text-gray-600">
                  Powered by ChainPay on ICP
                </div>
              </div>
            ) : (
              <div className="text-gray-500">Loading payment link...</div>
            )}
          </div>
        )}

        {/* Wallet View */}
        {view === "wallet" && isAuthenticated && (
          <div className="max-w-lg mx-auto">
            <h2 className="text-2xl font-bold mb-6">Wallet</h2>

            <div className="bg-surface rounded-xl p-5 border border-white/5 mb-6">
              <h3 className="text-sm text-gray-400 mb-3">Your Balances</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-gray-300">ICP</span>
                  <span className="text-brand font-bold text-xl">
                    {icpBalance !== null
                      ? formatAmount(icpBalance, "icp")
                      : "Loading..."}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-300">ckBTC</span>
                  <span className="text-brand font-bold text-xl">
                    {ckbtcBalance !== null
                      ? formatAmount(ckbtcBalance, "ckbtc")
                      : "Loading..."}
                  </span>
                </div>
              </div>
              <button
                onClick={loadBalances}
                className="mt-3 text-xs text-gray-500 hover:text-white cursor-pointer bg-transparent border-none"
              >
                Refresh balances
              </button>
            </div>

            <div className="bg-surface rounded-xl p-5 border border-white/5 mb-4">
              <h3 className="text-sm text-gray-400 mb-1">Your Principal</h3>
              <div
                className="font-mono text-xs text-brand break-all cursor-pointer hover:bg-white/5 rounded p-2 transition"
                onClick={() => {
                  navigator.clipboard.writeText(principal);
                  setSuccess("Principal copied!");
                }}
              >
                {principal}
              </div>
              <p className="text-xs text-gray-600 mt-1">Click to copy. Use this to receive tokens from others.</p>
            </div>

            <div className="bg-surface rounded-xl p-5 border border-white/5">
              <h3 className="font-semibold mb-4">Send Tokens</h3>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setLoading(true);
                  setError("");
                  setSuccess("");
                  try {
                    const actor = makeActor(authClient!.getIdentity());
                    const amountE8s = BigInt(
                      Math.round(parseFloat(withdrawAmount) * 100_000_000)
                    );
                    const result = await actor.withdraw(
                      withdrawTo,
                      amountE8s,
                      withdrawMethod === "icp"
                        ? PaymentMethod.icp
                        : PaymentMethod.ckbtc
                    );
                    const r = result as { __kind__: string; ok?: bigint; err?: string };
                    if (r.__kind__ === "ok") {
                      setSuccess(`Sent! Block index: ${r.ok}`);
                      setWithdrawTo("");
                      setWithdrawAmount("");
                      loadBalances();
                    } else {
                      setError(r.err || "Transfer failed");
                    }
                  } catch (e: unknown) {
                    setError((e as Error).message || "Transfer failed");
                  } finally {
                    setLoading(false);
                  }
                }}
                className="space-y-3"
              >
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    Recipient Principal
                  </label>
                  <input
                    type="text"
                    value={withdrawTo}
                    onChange={(e) => setWithdrawTo(e.target.value)}
                    placeholder="xxxxx-xxxxx-xxxxx-xxxxx-xxx"
                    required
                    className="w-full px-4 py-3 bg-bg border border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-brand font-mono text-xs"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">
                      Amount
                    </label>
                    <input
                      type="number"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      placeholder="1.0"
                      step="0.00000001"
                      min="0.00000001"
                      required
                      className="w-full px-4 py-3 bg-bg border border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">
                      Token
                    </label>
                    <select
                      value={withdrawMethod}
                      onChange={(e) =>
                        setWithdrawMethod(e.target.value as "icp" | "ckbtc")
                      }
                      className="w-full px-4 py-3 bg-bg border border-white/10 rounded-lg text-white focus:outline-none focus:border-brand"
                    >
                      <option value="icp">ICP</option>
                      <option value="ckbtc">ckBTC</option>
                    </select>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark transition disabled:opacity-50 cursor-pointer"
                >
                  {loading ? "Sending..." : "Send"}
                </button>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="bg-surface rounded-xl p-6 text-left">
      <div className="text-3xl mb-3" dangerouslySetInnerHTML={{ __html: icon }} />
      <h3 className="font-bold mb-2">{title}</h3>
      <p className="text-sm text-gray-400">{desc}</p>
    </div>
  );
}

function LinkCard({
  link,
  onCopy,
  onDeactivate,
  onReactivate,
}: {
  link: PaymentLinkInfo;
  onCopy: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const m = getMethod(link);
  return (
    <div className="bg-surface rounded-xl p-5 border border-white/5">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-bold">{link.title}</h3>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                link.active
                  ? "bg-green-500/20 text-green-400"
                  : "bg-red-500/20 text-red-400"
              }`}
            >
              {link.active ? "Active" : "Inactive"}
            </span>
          </div>
          {link.description && (
            <p className="text-sm text-gray-400 mb-2">{link.description}</p>
          )}
          <div className="flex items-center gap-4 text-sm">
            <span className="text-brand font-bold text-lg">
              {formatAmount(link.amount, m)}
            </span>
            <span className="text-gray-500">
              {link.paymentCount.toString()} payments
            </span>
            <span className="text-gray-500">
              {formatAmount(link.totalReceived, m)} received
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCopy}
            className="px-3 py-1.5 bg-surface-light rounded text-xs hover:bg-white/10 transition cursor-pointer"
          >
            Copy Link
          </button>
          {link.active ? (
            <button
              onClick={onDeactivate}
              className="px-3 py-1.5 bg-red-500/20 text-red-400 rounded text-xs hover:bg-red-500/30 transition cursor-pointer"
            >
              Deactivate
            </button>
          ) : (
            <button
              onClick={onReactivate}
              className="px-3 py-1.5 bg-green-500/20 text-green-400 rounded text-xs hover:bg-green-500/30 transition cursor-pointer"
            >
              Reactivate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

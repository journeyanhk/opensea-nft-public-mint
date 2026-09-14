import { Interface, JsonRpcProvider, Wallet, ZeroAddress, formatEther, getAddress } from "ethers";
import { resolveChain, explorerTx } from "./chains";
import { resolveRpcsForChain } from "./rpc-resolver";
import { SEADROP_ADDRESS, buildLocalMintPlan } from "./seadrop-public";
import { MintApiError, waitForEligibleStage } from "./stage-wait";
import { askHidden, askNumber, askText, askYesNo } from "./prompt";

const params = "tuple(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)";
export const allowlistInterface = new Interface([
  `function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,${params} mintParams,uint256 salt,bytes signature) payable`,
  `function mintAllowList(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,${params} mintParams,bytes32[] proof) payable`,
]);

async function api(slug: string, suffix = "", body?: object): Promise<any> {
  const key = process.env.OPENSEA_API_KEY?.trim();
  if (!key) throw new Error("OPENSEA_API_KEY in .env is required to check/mint Allowlist.");
  const response = await fetch(`https://api.opensea.io/api/v2/drops/${encodeURIComponent(slug)}${suffix}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok) {
    const reasons: Record<number, string> = {
      401: "Invalid API key", 403: "OpenSea refused access", 404: "Drop not found",
      409: "Drop not open, ended, or paused",
      422: "Mint cannot be created: wallet may not be allowlisted, allowance/supply exhausted, or balance insufficient",
      429: "OpenSea rate limited, try again later",
    };
    throw new MintApiError(response.status, `${reasons[response.status] || "OpenSea API error"} (HTTP ${response.status}). Eligibility not confirmed.`);
  }
  return response.json();
}

export function validateAllowlistTx(raw: any, contract: string, chain: string, wallet: string, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error("Quantity must be between 1 and 100.");
  if (raw.chain !== chain || getAddress(raw.to) !== getAddress(SEADROP_ADDRESS)) throw new Error("Transaction is for the wrong chain/SeaDrop.");
  if (typeof raw.value !== "string" || !/^\d+$/.test(raw.value)) throw new Error("Invalid transaction value.");
  const decoded = allowlistInterface.parseTransaction({ data: raw.data });
  if (!decoded) throw new Error("Not a supported Allowlist transaction.");
  const a = decoded.args;
  if (getAddress(a.nftContract) !== getAddress(contract) || a.quantity !== BigInt(quantity)) throw new Error("Collection/quantity mismatch.");
  if (a.minterIfNotPayer !== ZeroAddress && getAddress(a.minterIfNotPayer) !== getAddress(wallet)) throw new Error("Wrong NFT recipient wallet.");
  const p = a.mintParams;
  const value = BigInt(raw.value);
  if (value !== p.mintPrice * BigInt(quantity) || p.feeBps > 10_000n || p.dropStageIndex === 0n) throw new Error("Invalid mint parameters.");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < p.startTime || now >= p.endTime) throw new Error("Allowlist stage not open or already ended.");
  return { to: getAddress(raw.to), data: raw.data as string, value, method: decoded.name, stage: p.dropStageIndex.toString() };
}

export async function checkAllowlist(slug: string, address: string, quantity: number, allowPublic = false) {
  const wallet = getAddress(address);
  const drop = await api(slug);
  const chain = resolveChain(drop.chain);
  if (!chain || typeof drop.contract_address !== "string") throw new Error("Drop/chain not supported.");
  console.log(`Collection: ${slug} | ${chain.name} | ${drop.contract_address}`);
  const raw = await api(slug, "/mint", { minter: wallet, quantity });
  const publicInterface = new Interface(["function mintPublic(address,address,address,uint256) payable"]);
  const isPublic = typeof raw.data === "string" && raw.data.startsWith(publicInterface.getFunction("mintPublic")!.selector);
  if (isPublic && !allowPublic) throw new Error("API chose the Public stage; this mode only checks Allowlist.");
  let tx = isPublic ? undefined : validateAllowlistTx(raw, drop.contract_address, chain.key, wallet, quantity);
  const urls = resolveRpcsForChain(chain.key).urls;
  for (const url of urls) {
    const provider = new JsonRpcProvider(url);
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(chain.chainId)) throw new Error("RPC is on the wrong chain.");
      if (isPublic) {
        const plan = await buildLocalMintPlan(url, drop.contract_address, quantity);
        if (!plan || raw.chain !== chain.key || getAddress(raw.to) !== getAddress(plan.to) ||
          raw.data.toLowerCase() !== plan.data.toLowerCase() || raw.value !== plan.value.toString()) {
          throw new Error("Public API data does not match on-chain.");
        }
        tx = { to: plan.to, data: plan.data, value: plan.value, method: "mintPublic", stage: "0" };
      }
      if (!tx) throw new Error("Missing mint data.");
      await provider.call({ from: wallet, to: tx.to, data: tx.data, value: tx.value });
      console.log(`✓ Eligible now: ${wallet} | ${tx.method} | stage ${tx.stage} | ${quantity} NFT | ${formatEther(tx.value)} ${chain.nativeSymbol}`);
      return { tx, chain, rpcUrl: url };
    } catch {
      // A failed RPC or simulation is unknown, never evidence of ineligibility.
    } finally {
      provider.destroy();
    }
  }
  throw new Error("OpenSea returned mint data, but the on-chain simulation failed. Mint not confirmed; no transaction will be sent.");
}

export function hasLivePresale(drop: any, now = Date.now()): boolean {
  if (!Array.isArray(drop.stages)) throw new Error("OpenSea returned no mint schedule; cannot auto-select a stage.");
  return drop.stages.some((stage: any) => {
    const start = Date.parse(stage.start_time);
    const end = Date.parse(stage.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Invalid mint schedule.");
    return stage.stage_type !== "public_sale" && start <= now && now < end;
  });
}

export async function detectPresale(slug: string, contract: string, chain: string): Promise<boolean> {
  const drop = await api(slug);
  if (drop.chain !== chain || getAddress(drop.contract_address) !== getAddress(contract)) {
    throw new Error("OpenSea schedule does not match the selected collection/chain.");
  }
  return hasLivePresale(drop) || drop.stages.some((stage: any) =>
    stage.stage_type !== "public_sale" && Date.parse(stage.start_time) > Date.now());
}

export async function runAllowlistWizard(checkOnly: boolean, existing?: { slug: string; key: string; quantity: number }): Promise<void> {
  const input = existing?.slug ?? await askText("OpenSea link or collection slug");
  const slug = input.startsWith("https://opensea.io/collection/")
    ? new URL(input).pathname.split("/")[2] : input;
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) throw new Error("Invalid slug.");
  const address = existing ? new Wallet(existing.key).address : getAddress(await askText("Public wallet address (0x...)") );
  const quantity = existing?.quantity ?? await askNumber("NFT quantity", 1, { min: 1, max: 100 });
  const checked = checkOnly ? await checkAllowlist(slug, address, quantity) : await waitForEligibleStage({
    check: () => checkAllowlist(slug, address, quantity, true),
    schedule: () => api(slug),
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: message => console.log(message),
  });
  if (checkOnly) return;
  const provider = new JsonRpcProvider(checked.rpcUrl);
  try {
    const wallet = new Wallet(existing?.key ?? await askHidden("Private key for the wallet above (hidden input, RAM only): "), provider);
    if (wallet.address !== address) throw new Error("Private key does not match the checked wallet.");
    const { tx } = checked;
    const request = { to: tx.to, data: tx.data, value: tx.value, chainId: checked.chain.chainId };
    const estimate = await wallet.estimateGas(request);
    const gasLimit = (estimate * 120n + 99n) / 100n;
    const fees = await provider.getFeeData();
    if (fees.maxFeePerGas === null || fees.maxPriorityFeePerGas === null) throw new Error("Could not read EIP-1559 fees.");
    const maxCost = tx.value + gasLimit * fees.maxFeePerGas;
    if (await provider.getBalance(address) < maxCost) throw new Error("Wallet balance is insufficient for mint + max gas.");
    console.log(`Wallet: ${address}\nSeaDrop: ${tx.to}\nQuantity: ${quantity}\nMint value: ${formatEther(tx.value)}\nTotal mint + gas cap: ${formatEther(maxCost)} ${checked.chain.nativeSymbol}`);
    if (!(await askYesNo(`Send the ${tx.method} transaction at stage ${tx.stage}?`, false))) return;
    if (tx.method !== "mintPublic") validateAllowlistTx({ ...tx, value: tx.value.toString(), chain: checked.chain.key },
      allowlistInterface.parseTransaction({ data: tx.data })!.args.nftContract, checked.chain.key, address, quantity);
    if ((await provider.getNetwork()).chainId !== BigInt(checked.chain.chainId)) throw new Error("RPC is on the wrong chain.");
    await provider.call({ ...request, from: address });
    const sent = await wallet.sendTransaction({ ...request, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    console.log(`Sent: ${explorerTx(checked.chain.chainId, sent.hash)}`);
    const receipt = await sent.wait(1, 60_000);
    console.log(receipt?.status === 1 ? "Mint succeeded." : "Not yet confirmed; check the explorer.");
  } finally {
    provider.destroy();
  }
}
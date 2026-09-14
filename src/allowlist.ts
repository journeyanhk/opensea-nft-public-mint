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
  if (!key) throw new Error("需要 .env 中的 OPENSEA_API_KEY 才能检查/mint Allowlist。");
  const response = await fetch(`https://api.opensea.io/api/v2/drops/${encodeURIComponent(slug)}${suffix}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok) {
    const reasons: Record<number, string> = {
      401: "API key 无效", 403: "OpenSea 拒绝访问", 404: "未找到 drop",
      409: "Drop 未开始、已结束或已暂停",
      422: "无法创建 mint：钱包可能不在 allowlist、额度/supply 已用完或余额不足",
      429: "OpenSea 频率受限，请稍后重试",
    };
    throw new MintApiError(response.status, `${reasons[response.status] || "OpenSea API 错误"} (HTTP ${response.status})。尚未确认 eligibility。`);
  }
  return response.json();
}

export function validateAllowlistTx(raw: any, contract: string, chain: string, wallet: string, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error("数量必须为 1 到 100。");
  if (raw.chain !== chain || getAddress(raw.to) !== getAddress(SEADROP_ADDRESS)) throw new Error("交易链/SeaDrop 不正确。");
  if (typeof raw.value !== "string" || !/^\d+$/.test(raw.value)) throw new Error("交易 value 无效。");
  const decoded = allowlistInterface.parseTransaction({ data: raw.data });
  if (!decoded) throw new Error("不是受支持的 Allowlist 交易。");
  const a = decoded.args;
  if (getAddress(a.nftContract) !== getAddress(contract) || a.quantity !== BigInt(quantity)) throw new Error("collection/数量不匹配。");
  if (a.minterIfNotPayer !== ZeroAddress && getAddress(a.minterIfNotPayer) !== getAddress(wallet)) throw new Error("NFT 接收钱包不匹配。");
  const p = a.mintParams;
  const value = BigInt(raw.value);
  if (value !== p.mintPrice * BigInt(quantity) || p.feeBps > 10_000n || p.dropStageIndex === 0n) throw new Error("mint 参数无效。");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < p.startTime || now >= p.endTime) throw new Error("Allowlist 轮次未开始或已结束。");
  return { to: getAddress(raw.to), data: raw.data as string, value, method: decoded.name, stage: p.dropStageIndex.toString() };
}

export async function checkAllowlist(slug: string, address: string, quantity: number, allowPublic = false) {
  const wallet = getAddress(address);
  const drop = await api(slug);
  const chain = resolveChain(drop.chain);
  if (!chain || typeof drop.contract_address !== "string") throw new Error("该 Drop/链暂不支持。");
  console.log(`Collection: ${slug} | ${chain.name} | ${drop.contract_address}`);
  const raw = await api(slug, "/mint", { minter: wallet, quantity });
  const publicInterface = new Interface(["function mintPublic(address,address,address,uint256) payable"]);
  const isPublic = typeof raw.data === "string" && raw.data.startsWith(publicInterface.getFunction("mintPublic")!.selector);
  if (isPublic && !allowPublic) throw new Error("API 选择了 Public 轮次；此模式仅检查 Allowlist。");
  let tx = isPublic ? undefined : validateAllowlistTx(raw, drop.contract_address, chain.key, wallet, quantity);
  const urls = resolveRpcsForChain(chain.key).urls;
  for (const url of urls) {
    const provider = new JsonRpcProvider(url);
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(chain.chainId)) throw new Error("RPC 链不正确。");
      if (isPublic) {
        const plan = await buildLocalMintPlan(url, drop.contract_address, quantity);
        if (!plan || raw.chain !== chain.key || getAddress(raw.to) !== getAddress(plan.to) ||
          raw.data.toLowerCase() !== plan.data.toLowerCase() || raw.value !== plan.value.toString()) {
          throw new Error("Public API 数据与链上不一致。");
        }
        tx = { to: plan.to, data: plan.data, value: plan.value, method: "mintPublic", stage: "0" };
      }
      if (!tx) throw new Error("缺少 mint 数据。");
      await provider.call({ from: wallet, to: tx.to, data: tx.data, value: tx.value });
      console.log(`✓ 当前 Eligible: ${wallet} | ${tx.method} | stage ${tx.stage} | ${quantity} 个 NFT | ${formatEther(tx.value)} ${chain.nativeSymbol}`);
      return { tx, chain, rpcUrl: url };
    } catch {
      // A failed RPC or simulation is unknown, never evidence of ineligibility.
    } finally {
      provider.destroy();
    }
  }
  throw new Error("OpenSea 返回了 mint 数据，但链上模拟未成功。尚未确认可以 mint；不发送交易。");
}

export function hasLivePresale(drop: any, now = Date.now()): boolean {
  if (!Array.isArray(drop.stages)) throw new Error("OpenSea 缺少 mint 排期；无法自动选择轮次。");
  return drop.stages.some((stage: any) => {
    const start = Date.parse(stage.start_time);
    const end = Date.parse(stage.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("mint 排期无效。");
    return stage.stage_type !== "public_sale" && start <= now && now < end;
  });
}

export async function detectPresale(slug: string, contract: string, chain: string): Promise<boolean> {
  const drop = await api(slug);
  if (drop.chain !== chain || getAddress(drop.contract_address) !== getAddress(contract)) {
    throw new Error("OpenSea 排期与所选的 collection/链不匹配。");
  }
  return hasLivePresale(drop) || drop.stages.some((stage: any) =>
    stage.stage_type !== "public_sale" && Date.parse(stage.start_time) > Date.now());
}

export async function runAllowlistWizard(checkOnly: boolean, existing?: { slug: string; key: string; quantity: number }): Promise<void> {
  const input = existing?.slug ?? await askText("OpenSea 链接或 collection slug");
  const slug = input.startsWith("https://opensea.io/collection/")
    ? new URL(input).pathname.split("/")[2] : input;
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) throw new Error("Slug 无效。");
  const address = existing ? new Wallet(existing.key).address : getAddress(await askText("公开钱包地址 (0x...)") );
  const quantity = existing?.quantity ?? await askNumber("NFT 数量", 1, { min: 1, max: 100 });
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
    const wallet = new Wallet(existing?.key ?? await askHidden("上述钱包的私钥（隐藏输入，仅保存在内存中）："), provider);
    if (wallet.address !== address) throw new Error("私钥与已检查的钱包不匹配。");
    const { tx } = checked;
    const request = { to: tx.to, data: tx.data, value: tx.value, chainId: checked.chain.chainId };
    const estimate = await wallet.estimateGas(request);
    const gasLimit = (estimate * 120n + 99n) / 100n;
    const fees = await provider.getFeeData();
    if (fees.maxFeePerGas === null || fees.maxPriorityFeePerGas === null) throw new Error("无法读取 EIP-1559 费用。");
    const maxCost = tx.value + gasLimit * fees.maxFeePerGas;
    if (await provider.getBalance(address) < maxCost) throw new Error("钱包余额不足以支付 mint + 最大 gas。");
    console.log(`钱包: ${address}\nSeaDrop: ${tx.to}\n数量: ${quantity}\nmint 金额: ${formatEther(tx.value)}\nmint + gas 总上限: ${formatEther(maxCost)} ${checked.chain.nativeSymbol}`);
    if (!(await askYesNo(`发送该 stage ${tx.stage} 的 ${tx.method} 交易？`, false))) return;
    if (tx.method !== "mintPublic") validateAllowlistTx({ ...tx, value: tx.value.toString(), chain: checked.chain.key },
      allowlistInterface.parseTransaction({ data: tx.data })!.args.nftContract, checked.chain.key, address, quantity);
    if ((await provider.getNetwork()).chainId !== BigInt(checked.chain.chainId)) throw new Error("RPC 链不正确。");
    await provider.call({ ...request, from: address });
    const sent = await wallet.sendTransaction({ ...request, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    console.log(`已发送: ${explorerTx(checked.chain.chainId, sent.hash)}`);
    const receipt = await sent.wait(1, 60_000);
    console.log(receipt?.status === 1 ? "Mint 成功。" : "尚未确认成功；请查看区块浏览器。");
  } finally {
    provider.destroy();
  }
}

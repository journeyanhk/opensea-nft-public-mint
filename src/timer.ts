import chalk from "chalk";
import ora from "ora";

export async function waitForMintTime(mintTime: Date, earlyFireMs: number = 0): Promise<void> {
  // Fire early by earlyFireMs — tx sits in mempool and lands the moment contract allows
  const fireTime = new Date(mintTime.getTime() - earlyFireMs);
  const now = new Date();
  const diff = fireTime.getTime() - now.getTime();

  if (diff <= 0) {
    console.log(chalk.yellow("  发送时间已过 — 立即发送。"));
    return;
  }

  console.log(chalk.bold.white(`\n⏰ mint 时间: ${mintTime.toISOString()}`));
  if (earlyFireMs > 0) {
    console.log(chalk.bold.yellow(`  🔥 提前发送: 早于 mint 时间 ${earlyFireMs}ms → 发送于 ${fireTime.toISOString()}`));
  }
  console.log(chalk.gray(`  当前: ${now.toISOString()} | 等待 ${Math.ceil(diff / 1000)} 秒...\n`));

  // If more than 10 seconds away, show a countdown spinner
  if (diff > 10000) {
    const spinner = ora({
      text: formatCountdown(fireTime),
      color: "cyan",
    }).start();

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const remaining = fireTime.getTime() - Date.now();

        if (remaining <= 5000) {
          clearInterval(interval);
          spinner.stop();
          resolve();
        } else {
          spinner.text = formatCountdown(fireTime);
        }
      }, 500);
    });
  }

  // Precise wait for the last few seconds using a tight loop
  const remaining = fireTime.getTime() - Date.now();
  if (remaining > 0) {
    if (remaining > 100) {
      await new Promise((resolve) =>
        setTimeout(resolve, remaining - 100)
      );
    }

    // Tight spin-wait for the final milliseconds
    while (Date.now() < fireTime.getTime()) {
      // Spin-wait — burns CPU but gives sub-ms precision
    }
  }

  console.log(chalk.bold.green("  🟢 正在发送！\n"));
}

function formatCountdown(target: Date): string {
  const diff = target.getTime() - Date.now();
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);

  if (hours > 0) {
    return `  等待中... 还剩 ${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  }
  if (minutes > 0) {
    return `  等待中... 还剩 ${minutes} 分 ${seconds} 秒`;
  }
  return `  等待中... 还剩 ${seconds} 秒`;
}

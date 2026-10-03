import { assert } from "./validate.mjs";

export function validDate(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

function finite(value) {
  assert(
    Number.isFinite(value),
    "收益统计出现非有限数或数值溢出，请缩小数值范围或调整输入。",
  );
  return value;
}

function average(values) {
  return finite(
    values.reduce((sum, value) => finite(sum + value), 0) / values.length,
  );
}

export function sampleStd(values) {
  assert(
    Array.isArray(values) &&
      values.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ),
    "样本必须由有限数值组成。",
  );
  if (values.length < 2) return null;
  if (values.every((value) => value === values[0])) return 0;
  const mean = average(values);
  const differences = values.map((value) => finite(value - mean));
  const scale = differences.reduce(
    (largest, value) => Math.max(largest, Math.abs(value)),
    0,
  );
  assert(scale > 0, "非恒定样本的波动低于可表示精度，无法可靠计算标准差。");
  const scaledSquares = differences.reduce(
    (sum, value) => sum + (value / scale) ** 2,
    0,
  );
  const result = finite(scale * Math.sqrt(scaledSquares / (values.length - 1)));
  assert(result > 0, "非恒定样本的标准差低于可表示精度，无法可靠计算。");
  return result;
}

/** Performance of decimal simple returns, measured in observed periods. */
export function computePerformance(
  returns,
  periodsPerYear,
  annualRiskFree = 0,
) {
  assert(Array.isArray(returns) && returns.length >= 1, "至少需要一期收益率。");
  assert(
    returns.every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= -1,
    ),
    "收益率必须是大于或等于 -1 的有限数值。",
  );
  assert(
    Number.isInteger(periodsPerYear) &&
      periodsPerYear >= 1 &&
      periodsPerYear <= 365,
    "每年期数必须是 1–365 的整数。",
  );
  assert(
    typeof annualRiskFree === "number" &&
      Number.isFinite(annualRiskFree) &&
      annualRiskFree > -1 &&
      annualRiskFree <= 1,
    "年化无风险收益必须大于 -1 且不超过 1。",
  );
  const warnings = [];
  const periods = returns.length;
  const equity = [1];
  const drawdown = [0];
  let peak = 1;
  let underflow = false;
  for (const value of returns) {
    const factor = finite(1 + value);
    const previous = equity.at(-1);
    const next = finite(previous * factor);
    if (previous > 0 && factor > 0 && next === 0) underflow = true;
    equity.push(next);
    peak = Math.max(peak, next);
    drawdown.push(finite(next / peak - 1));
  }
  const totalReturn = finite(equity.at(-1) - 1);
  const annualReturn = finite(
    finite(Math.pow(equity.at(-1), periodsPerYear / periods)) - 1,
  );
  const rfPeriod = finite(
    finite(Math.pow(finite(1 + annualRiskFree), 1 / periodsPerYear)) - 1,
  );
  const standardDeviation = sampleStd(returns);
  const annualVolatility =
    standardDeviation === null
      ? null
      : finite(standardDeviation * Math.sqrt(periodsPerYear));
  let sharpe = null;
  if (periods < 2)
    warnings.push("仅有一期收益，样本波动率与 Sharpe 未定义，返回空值。");
  else {
    const excess = returns.map((value) => finite(value - rfPeriod));
    const excessStd = sampleStd(excess);
    if (excessStd === 0)
      warnings.push(
        "超额收益零波动，Sharpe 未定义，返回空值；不会显示为无穷大。",
      );
    else
      sharpe = finite(
        finite(average(excess) / excessStd) * Math.sqrt(periodsPerYear),
      );
  }
  if (periods < periodsPerYear)
    warnings.push(
      `只有 ${periods} 个收益期，少于按每年 ${periodsPerYear} 期计的一年；年化结果对短样本较敏感。`,
    );
  if (returns.includes(-1))
    warnings.push(
      "输入包含 -100% 的单期收益；此后净值保持零，不会因后续正收益恢复。",
    );
  if (underflow)
    warnings.push("净值曾低于可表示的数值精度，路径从该期起记录为零。");
  const metrics = {
    periods,
    totalReturn,
    annualReturn,
    annualVolatility,
    sharpe,
    maxDrawdown: Math.min(...drawdown),
    positivePeriodRate: returns.filter((value) => value > 0).length / periods,
  };
  return { metrics, equity, drawdown, warnings };
}

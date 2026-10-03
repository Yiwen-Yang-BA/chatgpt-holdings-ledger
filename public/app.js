import {
  $,
  escape,
  toast,
  download,
  csv,
  load,
  save,
  init,
  run,
  busy,
  resultMeta,
  fileText,
} from "./ui.js";
import { num, pct, bars } from "./charts.js";
import { reportHTML } from "./reports.js";
let result = null,
  pending = false;
const key = "holdings-ledger.v1";
const holdingHeaders = [
  "资产",
  "数量",
  "均价成本",
  "剩余成本",
  "手动标价",
  "市值",
  "已实现盈亏",
  "未实现盈亏",
  "总盈亏",
  "市值占比",
];
function lock(on) {
  pending = on;
  document
    .querySelectorAll(
      ".data-layout input,.data-layout textarea,.data-layout select,#sample,#analyze,#add-trade,#save-local,#backup,#mode",
    )
    .forEach((el) => (el.disabled = on));
}
function snapshot() {
  return {
    kind: "holdings-ledger",
    version: 1,
    currency: $("#currency").value,
    asOf: $("#as-of").value,
    transactionsCsv: $("#transactions").value,
    marksCsv: $("#marks").value,
  };
}
function validateBackup(s) {
  if (
    !s ||
    s.kind !== "holdings-ledger" ||
    s.version !== 1 ||
    !["CNY", "USD", "EUR"].includes(s.currency) ||
    typeof s.asOf !== "string" ||
    s.asOf.length > 10 ||
    typeof s.transactionsCsv !== "string" ||
    s.transactionsCsv.length > 225000 ||
    typeof s.marksCsv !== "string" ||
    s.marksCsv.length > 25000
  )
    throw Error("不是有效的 Holdings Ledger v1 输入备份");
  return s;
}
function restore(s) {
  validateBackup(s);
  $("#currency").value = s.currency;
  $("#as-of").value = s.asOf;
  $("#transactions").value = s.transactionsCsv;
  $("#marks").value = s.marksCsv;
}
function sample() {
  restore({
    kind: "holdings-ledger",
    version: 1,
    currency: "CNY",
    asOf: "2025-03-31",
    transactionsCsv:
      "date,symbol,side,quantity,price,fee\n2025-01-02,ALPHA,buy,10,10,2\n2025-01-10,ALPHA,buy,10,20,2\n2025-02-02,ALPHA,sell,5,18,1\n2025-02-03,BETA,buy,20,25,2\n2025-02-20,BETA,sell,4,30,1\n2025-03-01,GAMMA,buy,8,50,2",
    marksCsv: "symbol,price\nALPHA,16\nBETA,28\nGAMMA,48",
  });
  $("#trade-date").value = "2025-03-02";
}
function table(headers, rows) {
  return (
    '<table class="data-table"><thead><tr>' +
    headers.map((h) => "<th>" + escape(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          row.map((c) => "<td>" + escape(c) + "</td>").join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}
function holdingsRows(raw = false) {
  return result.holdings.map((h) => [
    h.symbol,
    h.quantity,
    ...[
      h.averageCost,
      h.costBasis,
      h.markPrice,
      h.marketValue,
      h.realizedPnl,
      h.unrealizedPnl,
      h.totalPnl,
    ].map((v) => (raw ? v : num(v, 4))),
    raw ? h.weight : pct(h.weight),
  ]);
}
const txnHeaders = [
  "日期",
  "资产",
  "方向",
  "数量",
  "价格",
  "费用",
  "释放成本",
  "本笔实现盈亏",
  "剩余数量",
  "剩余成本",
];
function txnRows() {
  return result.transactions.map((t) => [
    t.date,
    t.symbol,
    t.side === "buy" ? "买入" : "卖出",
    t.quantity,
    ...[t.price, t.fee, t.releasedCost, t.realizedPnl].map((v) => num(v, 4)),
    t.quantityAfter,
    num(t.costBasisAfter, 4),
  ]);
}
function render(r) {
  result = { ...r.data, meta: r.meta };
  const s = result.summary;
  $("#metrics").innerHTML = [
    ["总持仓市值", s.marketValue],
    ["已实现盈亏", s.realizedPnl],
    ["未实现盈亏", s.unrealizedPnl],
    ["累计总盈亏", s.totalPnl],
  ]
    .map(
      ([label, value]) =>
        `<div class="metric-card"><span>${label} · ${result.settings.currency}</span><strong>${num(value)}</strong></div>`,
    )
    .join("");
  $("#valuation-label").textContent =
    result.settings.asOf + " · " + result.settings.currency;
  const positions = result.holdings.filter(
    (h) => h.quantity > 0 && h.marketValue !== null,
  );
  $("#allocation-chart").innerHTML = positions.length
    ? bars(
        positions.map((h) => ({ label: h.symbol, value: h.marketValue })),
        { label: "已估值部分的持仓市值" },
      )
    : '<p class="muted">暂无具备手动标价的未平仓资产。</p>';
  $("#coverage").textContent =
    `已估值 ${s.pricedPositions}/${s.openPositions} 个未平仓资产，已估值部分市值 ${num(s.knownMarketValue)} ${result.settings.currency}。${s.completeValuation ? "估值完整。" : "缺标价：" + s.missingMarks.join("、") + "；总市值和总盈亏暂不可计算。"} 实际累计费用 ${num(s.totalFees)}。`;
  $("#holdings").innerHTML = table(holdingHeaders, holdingsRows());
  $("#transactions-table").innerHTML = table(txnHeaders, txnRows());
  $("#warnings").textContent = result.warnings.join("\n");
  $("#meta").innerHTML = resultMeta(r.meta);
  $("#insight").textContent = result.insight;
  $("#exports").hidden = false;
}
$("#sample").onclick = sample;
for (const [id, max] of [
  ["transactions", 225000],
  ["marks", 25000],
])
  $("#" + id + "-file").onchange = async (e) => {
    if (pending) return;
    lock(true);
    try {
      const f = e.target.files[0];
      if (!f) return;
      if (!/\.csv$/i.test(f.name)) throw Error("请选择 CSV 文件");
      const text = await fileText(f, max * 3);
      if (text.length > max) throw Error(`超过 ${max} 字符限制`);
      $("#" + id).value = text;
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.value = "";
      lock(false);
    }
  };
$("#ledger-form").onsubmit = async (e) => {
  e.preventDefault();
  if (pending) return;
  lock(true);
  busy($("#analyze"), true, "逐笔核对成本…");
  try {
    const s = snapshot();
    render(
      await run({
        transactionsCsv: s.transactionsCsv,
        marksCsv: s.marksCsv || "symbol,price",
        currency: s.currency,
        asOf: s.asOf,
      }),
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy($("#analyze"), false);
    lock(false);
  }
};
$("#trade-form").onsubmit = (e) => {
  e.preventDefault();
  if (pending) return;
  const base =
    $("#transactions").value.trim() || "date,symbol,side,quantity,price,fee";
  const fields = base
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/, 1)[0]
    .split(",")
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1"));
  const values = {
    date: $("#trade-date").value,
    symbol: $("#symbol").value.trim(),
    side: $("#side").value,
    quantity: $("#quantity").value,
    price: $("#price").value,
    fee: $("#fee").value,
  };
  if (
    fields.length !== 6 ||
    new Set(fields).size !== 6 ||
    fields.some((k) => !Object.hasOwn(values, k))
  ) {
    toast("快速追加需要标准的六列CSV表头，请先核对流水表头。", true);
    return;
  }
  const row = fields.map((k) => values[k]).join(",");
  const text = base + "\n" + row;
  if (text.length > 225000) {
    toast("流水超过字符限制，请先导出整理", true);
    return;
  }
  $("#transactions").value = text;
  $("#quantity").value = "";
  toast("已加入流水，请刷新持仓以核对。");
};
$("#save-local").onclick = () => {
  if (save(key, snapshot())) toast("当前输入已保存到此浏览器。");
};
$("#backup").onclick = () =>
  download(
    "holdings-backup.json",
    JSON.stringify(snapshot(), null, 2),
    "application/json",
  );
$("#restore").onchange = async (e) => {
  if (pending) return;
  lock(true);
  try {
    const f = e.target.files[0];
    if (!f) return;
    restore(JSON.parse(await fileText(f, 800000)));
    toast("备份已载入，请刷新持仓。");
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.value = "";
    lock(false);
  }
};
$("#export-json").onclick = () =>
  result &&
  download(
    "holdings-valuation.json",
    JSON.stringify(result, null, 2),
    "application/json",
  );
$("#export-csv").onclick = () =>
  result &&
  download(
    "holdings.csv",
    csv([holdingHeaders, ...holdingsRows(true)]),
    "text/csv;charset=utf-8",
  );
$("#export-html").onclick = () => {
  if (!result) return;
  const s = result.summary;
  download(
    "holdings-report.html",
    reportHTML({
      title: "持仓与盈亏核对报告",
      subtitle: `Holdings Ledger · ${result.settings.asOf} · ${result.settings.currency}`,
      metrics: [
        { label: "总持仓市值", value: num(s.marketValue) },
        { label: "已实现盈亏", value: num(s.realizedPnl) },
        { label: "未实现盈亏", value: num(s.unrealizedPnl) },
        { label: "累计总盈亏", value: num(s.totalPnl) },
      ],
      sections: [
        {
          title: "估值覆盖",
          text: `已估值 ${s.pricedPositions}/${s.openPositions} 个未平仓资产；已估值市值 ${num(s.knownMarketValue)}；缺标价：${s.missingMarks.join("、") || "无"}。`,
        },
        { title: "持仓与成本", headers: holdingHeaders, rows: holdingsRows() },
        { title: "逐笔成本核对", headers: txnHeaders, rows: txnRows() },
        { title: "解读", text: result.insight },
      ],
      notes: [
        "移动加权平均成本法，整股、单一币种。买入费用进入成本，卖出费用扣减实现盈亏。",
        "— 表示缺标价或未定义，不等于零。标价为用户手动输入；本报告不是税务报表。",
        ...result.warnings,
      ],
    }),
    "text/html;charset=utf-8",
  );
};
const saved = load(key, null);
if (saved) {
  try {
    restore(saved);
  } catch {
    toast("已保存输入格式无法识别，请导入有效备份。", true);
  }
}
await init();

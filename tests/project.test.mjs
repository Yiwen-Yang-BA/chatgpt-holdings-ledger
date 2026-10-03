import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../project.mjs";
import { ValidationError } from "../lib/validate.mjs";

const near = (actual, expected, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} ≈ ${expected}`,
  );
const header = "date,symbol,side,quantity,price,fee";
const defaults = {
  transactionsCsv: `${header}\n2026-01-01,ABC,buy,10,10,2\n2026-01-02,ABC,buy,10,20,2\n2026-01-03,ABC,sell,5,18,1`,
  marksCsv: "symbol,price\nABC,16",
  currency: "CNY",
  asOf: "2026-01-31",
};
const demo = { generate: async (spec) => spec.demo() };

test("method C preserves average cost, realized fees and remaining marked gain", async () => {
  const result = await run(defaults, demo),
    holding = result.holdings[0];
  assert.equal(result.transactions[1].costBasisAfter, 304);
  assert.equal(result.transactions[2].releasedCost, 76);
  assert.equal(holding.quantity, 15);
  assert.equal(holding.costBasis, 228);
  near(holding.averageCost, 15.2);
  assert.equal(holding.realizedPnl, 13);
  assert.equal(holding.marketValue, 240);
  assert.equal(holding.unrealizedPnl, 12);
  assert.equal(holding.totalPnl, 25);
  assert.equal(result.summary.totalPnl, 25);
  assert.equal(result.summary.totalFees, 5);
  assert.equal(holding.weight, 1);
});

test("full close clears basis exactly and a later buy opens a new average cost", async () => {
  const closedCsv = defaults.transactionsCsv + "\n2026-01-04,ABC,sell,15,16,1";
  const closed = await run(
    { ...defaults, transactionsCsv: closedCsv, marksCsv: "symbol,price" },
    demo,
  );
  assert.equal(closed.holdings[0].quantity, 0);
  assert.equal(closed.holdings[0].costBasis, 0);
  assert.equal(closed.holdings[0].averageCost, null);
  assert.equal(closed.holdings[0].marketValue, 0);
  assert.equal(closed.holdings[0].unrealizedPnl, 0);
  assert.equal(closed.summary.realizedPnl, 24);
  assert.equal(closed.summary.completeValuation, true);
  const reopened = await run(
    {
      ...defaults,
      transactionsCsv: closedCsv + "\n2026-01-05,ABC,buy,2,50,1",
      marksCsv: "symbol,price\nABC,52",
    },
    demo,
  );
  assert.equal(reopened.holdings[0].costBasis, 101);
  assert.equal(reopened.holdings[0].averageCost, 50.5);
  assert.equal(reopened.holdings[0].realizedPnl, 24);
  assert.equal(reopened.holdings[0].totalPnl, 27);
});

test("overselling is rejected and same-date rows retain their input order", async () => {
  await assert.rejects(
    run(
      {
        ...defaults,
        transactionsCsv:
          defaults.transactionsCsv + "\n2026-01-04,ABC,sell,16,16,1",
      },
      demo,
    ),
    /超过当前持仓/,
  );
  const buy = "2026-01-01,ABC,buy,1,10,0",
    sell = "2026-01-01,ABC,sell,1,11,0";
  const result = await run(
    { ...defaults, transactionsCsv: `${header}\n${buy}\n${sell}` },
    demo,
  );
  assert.equal(result.summary.realizedPnl, 1);
  await assert.rejects(
    run({ ...defaults, transactionsCsv: `${header}\n${sell}\n${buy}` }, demo),
    /超过当前持仓/,
  );
});

test("sale fees may exceed proceeds and are charged once, with no clamp to zero", async () => {
  const result = await run(
    {
      ...defaults,
      transactionsCsv: `${header}\n2026-01-01,ABC,buy,1,10,2\n2026-01-02,ABC,sell,1,1,3`,
      marksCsv: "symbol,price",
    },
    demo,
  );
  assert.equal(result.transactions[1].releasedCost, 12);
  assert.equal(result.summary.realizedPnl, -14);
  assert.equal(result.summary.totalFees, 5);
  assert.equal(result.summary.totalPnl, -14);
});

test("missing marks keep totals and all weights null while explicit zero marks remain valid", async () => {
  const transactionsCsv = `${header}\n2026-01-01,A,buy,10,10,0\n2026-01-02,B,buy,2,20,0`;
  const partial = await run(
    { ...defaults, transactionsCsv, marksCsv: "symbol,price\nA,0" },
    demo,
  );
  assert.equal(partial.holdings[0].markPrice, 0);
  assert.equal(partial.holdings[0].unrealizedPnl, -100);
  assert.equal(partial.holdings[1].marketValue, null);
  assert.deepEqual(partial.summary.missingMarks, ["B"]);
  assert.equal(partial.summary.knownMarketValue, 0);
  for (const field of ["marketValue", "unrealizedPnl", "totalPnl"])
    assert.equal(partial.summary[field], null);
  assert.ok(partial.holdings.every((item) => item.weight === null));
  const complete = await run(
    { ...defaults, transactionsCsv, marksCsv: "symbol,price\nA,0\nB,30" },
    demo,
  );
  assert.equal(complete.summary.pricedPositions, 2);
  assert.equal(complete.summary.marketValue, 60);
  assert.equal(complete.summary.totalPnl, -80);
  assert.deepEqual(
    complete.holdings.map((item) => item.weight),
    [0, 1],
  );
});

test("closed or unknown marks are ignored and all-zero valuation has no invented weights", async () => {
  const result = await run(
    {
      ...defaults,
      transactionsCsv: `${header}\n2026-01-01,ABC,buy,1,10,0\n2026-01-02,ABC,sell,1,11,0`,
      marksCsv: "symbol,price\nABC,100\nUNKNOWN,50",
    },
    demo,
  );
  assert.equal(result.summary.marketValue, 0);
  assert.equal(result.summary.totalPnl, 1);
  assert.equal(result.holdings[0].markPrice, null);
  assert.equal(result.holdings[0].weight, null);
  assert.ok(result.warnings.some((warning) => warning.includes("忽略 2")));
});

test("strict columns, dates, currency, symbols, quantities and duplicate marks are checked", async () => {
  const invalids = [
    { currency: "JPY" },
    { asOf: "2026-02-30" },
    { asOf: "2025-01-01" },
    {
      transactionsCsv: defaults.transactionsCsv.replace(
        "2026-01-02",
        "2025-01-02",
      ),
    },
    {
      transactionsCsv: defaults.transactionsCsv.replace(
        ",10,10,2",
        ",1.5,10,2",
      ),
    },
    {
      transactionsCsv: defaults.transactionsCsv.replace(
        ",ABC,",
        ",bad symbol,",
      ),
    },
    {
      transactionsCsv: defaults.transactionsCsv.replace(
        header,
        header + ",currency",
      ),
    },
    { marksCsv: "symbol,price\nABC,16\nABC,17" },
    { marksCsv: "symbol,price\nABC," },
    { marksCsv: "symbol,price\nABC,-1" },
  ];
  for (const invalid of invalids)
    await assert.rejects(
      run({ ...defaults, ...invalid }, demo),
      ValidationError,
    );
  const reordered = await run(
    {
      ...defaults,
      transactionsCsv:
        "symbol,date,fee,side,price,quantity\nABC,2026-01-01,0,buy,10,2",
      marksCsv: "price,symbol\n11,ABC",
    },
    demo,
  );
  assert.equal(reordered.summary.totalPnl, 2);
});

test("gross, aggregate basis, marked value and accumulated position size enforce limits", async () => {
  for (const transactionsCsv of [
    `${header}\n2026-01-01,A,buy,1000000000,1000000000,0`,
    `${header}\n2026-01-01,A,buy,1000,600000000,0\n2026-01-02,B,buy,1000,600000000,0`,
    `${header}\n2026-01-01,A,buy,1000000000,1,0\n2026-01-02,A,buy,1,1,0`,
  ])
    await assert.rejects(
      run({ ...defaults, transactionsCsv, marksCsv: "symbol,price" }, demo),
      ValidationError,
    );
  await assert.rejects(
    run(
      {
        ...defaults,
        transactionsCsv: `${header}\n2026-01-01,A,buy,1000000000,1,0`,
        marksCsv: "symbol,price\nA,1000000000",
      },
      demo,
    ),
    /分析范围/,
  );
});

test("near-full sale preserves the small remaining cost without an arbitrary zero cutoff", async () => {
  const result = await run(
    {
      ...defaults,
      transactionsCsv: `${header}\n2026-01-01,TINY,buy,1000000000,0.000000001,0\n2026-01-02,TINY,sell,999999999,0.000000001,0`,
      marksCsv: "symbol,price\nTINY,0.000000001",
    },
    demo,
  );
  assert.equal(result.holdings[0].quantity, 1);
  near(result.holdings[0].costBasis, 1e-9, 1e-20);
  assert.equal(result.holdings[0].averageCost, 1e-9);
  assert.ok(result.holdings[0].costBasis > 0);
});

test("model receives holdings and summary only, never raw transaction rows", async () => {
  let observed;
  const result = await run(defaults, {
    generate: async (spec) => {
      observed = spec;
      return { text: "只解释当前汇总。" };
    },
  });
  const input = JSON.parse(observed.input);
  assert.deepEqual(Object.keys(input), ["settings", "holdings", "summary"]);
  assert.equal(input.transactions, undefined);
  assert.ok(!observed.input.includes("2026-01-01"));
  assert.ok(!observed.input.includes("releasedCost"));
  assert.deepEqual(input.holdings, result.holdings);
  assert.match(observed.instructions, /Missing mark prices/);
  const preview = await run(defaults, demo);
  assert.match(preview.insight, /本地账本概览/);
});

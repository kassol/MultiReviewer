import assert from "node:assert/strict";
import { test } from "node:test";

import { costPresentation } from "../web/src/usage-cost.ts";

test("费用展示区分未记录、可信免费、已知正价和不完整小计", () => {
  assert.deepEqual(costPresentation(null), { amount: "费用未记录", note: null });
  assert.deepEqual(
    costPresentation({
      costUsd: 0,
      knownCostUsd: 0,
      costIncomplete: false,
      unknownCostReviewers: 0,
    }),
    { amount: "$0.0000", note: null },
  );
  assert.deepEqual(
    costPresentation({
      costUsd: 0.125,
      knownCostUsd: 0.125,
      costIncomplete: false,
      unknownCostReviewers: 0,
    }),
    { amount: "$0.1250", note: null },
  );
  assert.deepEqual(
    costPresentation({
      costUsd: null,
      knownCostUsd: 0.125,
      costIncomplete: true,
      unknownCostReviewers: 2,
    }),
    { amount: "已知小计 $0.1250", note: "2 个 Reviewer 费用未知" },
  );
});

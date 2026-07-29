import type { JobState } from "@citely/chain/types";
import { describe, expect, it } from "vitest";

import {
  assertLegalComposite,
  deriveCaseState,
  IllegalCompositeStateError,
  isCompositeTerminal,
} from "./composite.js";
import type { CompositeState } from "./composite.js";
import type { PartyTaskState } from "./state.js";

function composite(
  job: JobState,
  partyTasks: readonly PartyTaskState[],
  reviewJob: JobState | null = null,
): CompositeState {
  return { job, partyTasks, reviewJob };
}

describe("deriveCaseState —— 显式组合状态表（v2.3 §3.1）", () => {
  it.each([
    ["open", [], "intake"],
    ["funded", [], "intake"],
    ["funded", ["pending", "pending"], "decomposed"],
    ["funded", ["pending", "assessing"], "assessing"],
    ["funded", ["assessing", "awaiting_data"], "assessing"],
    ["funded", ["resolved", "awaiting_data"], "assessing"],
    ["funded", ["resolved", "resolved"], "conditions_ready"],
    ["submitted", ["resolved", "resolved"], "submitted"],
    ["completed", ["resolved"], "settled"],
    ["rejected", ["assessing"], "rejected"],
    ["expired", ["awaiting_data"], "rejected"],
  ] as const)("job=%s tasks=%j → %s", (job, tasks, expected) => {
    expect(deriveCaseState(composite(job, tasks))).toBe(expected);
  });

  it("多角色部分完成时仍是 assessing（不会因为某个角色先 resolve 就提前推进）", () => {
    expect(deriveCaseState(composite("funded", ["resolved", "resolved", "assessing"]))).toBe(
      "assessing",
    );
  });

  it("**顺序无关**：同一组角色状态换任意顺序，算出的案件状态相同", () => {
    const a = deriveCaseState(composite("funded", ["resolved", "awaiting_data", "pending"]));
    const b = deriveCaseState(composite("funded", ["pending", "resolved", "awaiting_data"]));
    const c = deriveCaseState(composite("funded", ["awaiting_data", "pending", "resolved"]));
    expect(a).toBe(b);
    expect(b).toBe(c);
    // 这正是"禁止隐式 promise 链"的可验证形式：并发完成顺序不影响案件状态。
    expect(a).toBe("assessing");
  });
});

describe("非法组合必须报错而不是静默通过", () => {
  it("没有任何角色任务却已 submitted/completed", () => {
    expect(() => deriveCaseState(composite("submitted", []))).toThrow(IllegalCompositeStateError);
    expect(() => deriveCaseState(composite("completed", []))).toThrow(IllegalCompositeStateError);
  });

  it("submitted 但仍有角色任务未 resolved（SA 覆盖不全）", () => {
    expect(() => deriveCaseState(composite("submitted", ["resolved", "assessing"]))).toThrow(
      IllegalCompositeStateError,
    );
    expect(() => deriveCaseState(composite("completed", ["awaiting_data"]))).toThrow(
      IllegalCompositeStateError,
    );
  });

  it("主 Job 还没提交就冒出子 Job（Review Job 随 SA 一起提交）", () => {
    expect(() => deriveCaseState(composite("funded", ["resolved"], "open"))).toThrow(
      IllegalCompositeStateError,
    );
    expect(() => deriveCaseState(composite("open", [], "open"))).toThrow(
      IllegalCompositeStateError,
    );
  });

  it("错误对象带上出错的组合，便于定位", () => {
    try {
      deriveCaseState(composite("submitted", ["assessing"]));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalCompositeStateError);
      expect((err as IllegalCompositeStateError).composite.job).toBe("submitted");
    }
  });
});

describe("合法组合", () => {
  it("终局态允许角色任务停在任意状态（超时/受理失败都可能中途发生）", () => {
    expect(() => {
      assertLegalComposite(composite("expired", ["pending", "awaiting_data"]));
    }).not.toThrow();
    expect(() => {
      assertLegalComposite(composite("rejected", ["assessing"]));
    }).not.toThrow();
  });

  it("submitted 之后可以有子 Job", () => {
    expect(() => {
      assertLegalComposite(composite("submitted", ["resolved"], "funded"));
    }).not.toThrow();
  });
});

describe("isCompositeTerminal", () => {
  it.each([
    ["completed", true],
    ["rejected", true],
    ["expired", true],
    ["open", false],
    ["funded", false],
    ["submitted", false],
  ] as const)("job=%s → %s", (job, expected) => {
    const tasks: readonly PartyTaskState[] = job === "open" || job === "funded" ? [] : ["resolved"];
    expect(isCompositeTerminal(composite(job, tasks))).toBe(expected);
  });
});

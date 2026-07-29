/**
 * USDC 6 位小数金额类型（v2.3 §9 工程注记）。
 *
 * 全部金额在代码与账本中**以最小单位整数存储运算**（100.00 USDC → `100000000n`），
 * 只有渲染层做小数转换。Circle Skills 把"拿浮点数当金额"列为高频错误。
 *
 * **为什么是 branded type 而不是 `type Usdc6 = bigint`**：
 * 裸别名对编译器等于 `bigint`，`const fee: Usdc6 = 100n` 照样通过——
 * 那只是注释，不是约束，而 v2.3 §9 与主导都明确要求"落成类型约束"。
 * 加了 brand 之后，想得到一个 `Usdc6` 只有两条路：{@link usdc6}（已是最小单位）
 * 或 {@link usdc6FromDecimal}（人写的小数字符串）。从别处飘来的裸 `bigint`
 * 必须显式经过其中一道门，**在门口就暴露"这个数到底是不是最小单位"**。
 *
 * 反方向是安全的：`Usdc6` 可以直接当 `bigint` 用（它是交叉类型），
 * 所以传给 chain 的 `splitFees()` 之类不需要任何转换，跨包边界零摩擦。
 */

declare const USDC6_BRAND: unique symbol;

/** 6 位小数 USDC 的最小单位整数。 */
export type Usdc6 = bigint & { readonly [USDC6_BRAND]: true };

/** 小数位数。USDC 在所有链上都是 6。 */
export const USDC_DECIMALS = 6;

/** 1 USDC 的最小单位数（`1_000_000n`）。 */
export const USDC_ONE = 10n ** BigInt(USDC_DECIMALS);

/** 金额非法（负数或形状不对）。 */
export class Usdc6Error extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Usdc6Error";
  }
}

/**
 * 把一个**已经是最小单位**的整数标记为 `Usdc6`。
 *
 * @param atomic - 最小单位整数，必须 ≥ 0（方向由账本的 `direction` 表达，不用负数）
 * @returns 带标记的金额
 * @throws {Usdc6Error} 负数
 */
export function usdc6(atomic: bigint): Usdc6 {
  if (atomic < 0n) {
    throw new Usdc6Error(`amount must be non-negative (direction is a separate field): ${String(atomic)}`);
  }
  return atomic as Usdc6;
}

/** 零。常用到值得给个名字。 */
export const USDC6_ZERO: Usdc6 = usdc6(0n);

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d{1,6}))?$/;

/**
 * 把人写的小数字符串转成最小单位（`"100.00"` → `100000000n`）。
 *
 * 只接受字符串：`number` 在 `0.1 + 0.2` 这种地方会悄悄错，金额不允许经过它。
 *
 * @param decimal - 十进制字符串，最多 6 位小数，不接受负号/科学计数法
 * @returns 最小单位金额
 * @throws {Usdc6Error} 形状非法或小数位超过 6
 */
export function usdc6FromDecimal(decimal: string): Usdc6 {
  const match = DECIMAL_PATTERN.exec(decimal.trim());
  if (match === null) {
    throw new Usdc6Error(`not a valid USDC amount (max ${String(USDC_DECIMALS)} decimals): ${decimal}`);
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  return usdc6(BigInt(whole) * USDC_ONE + BigInt(fraction));
}

/**
 * 从十进制字符串解析（账本/SA 里金额以字符串落盘，JSON 没有 bigint）。
 *
 * @param atomic - 最小单位的十进制整数字符串
 * @throws {Usdc6Error} 不是非负十进制整数
 */
export function usdc6FromAtomicString(atomic: string): Usdc6 {
  if (!/^\d+$/.test(atomic.trim())) {
    throw new Usdc6Error(`not a decimal atomic amount: ${atomic}`);
  }
  return usdc6(BigInt(atomic.trim()));
}

/** 落盘/上链用的最小单位十进制字符串。 */
export function usdc6ToAtomicString(value: Usdc6): string {
  return value.toString();
}

/**
 * **渲染层唯一**的小数转换点（`100000000n` → `"100.00"`）。
 *
 * 除了给人看的地方，任何计算都不许调它——一旦转成小数字符串再转回来就有精度风险。
 *
 * @param value - 最小单位金额
 * @param decimals - 显示几位小数，默认 2
 */
export function formatUsdc6(value: Usdc6, decimals = 2): string {
  if (decimals < 0 || decimals > USDC_DECIMALS) {
    throw new Usdc6Error(`decimals must be within 0..${String(USDC_DECIMALS)}, got ${String(decimals)}`);
  }
  const whole = value / USDC_ONE;
  const fraction = (value % USDC_ONE).toString().padStart(USDC_DECIMALS, "0");
  return decimals === 0 ? whole.toString() : `${whole.toString()}.${fraction.slice(0, decimals)}`;
}

/** 加法。结果仍是 `Usdc6`，不会意外退化成裸 `bigint`。 */
export function addUsdc6(a: Usdc6, b: Usdc6): Usdc6 {
  return usdc6(a + b);
}

/**
 * 减法。
 *
 * @throws {Usdc6Error} 结果为负——金额是量纲，方向由 `direction` 表达；
 *   出现负数说明调用方把两个不该相减的量相减了，响亮失败比静默记一笔负数安全
 */
export function subUsdc6(a: Usdc6, b: Usdc6): Usdc6 {
  return usdc6(a - b);
}

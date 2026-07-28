/**
 * 全仓**唯一**的 JSON 规范化实现。
 *
 * 两个下游共用它，任何分叉都会造成静默的哈希不一致：
 * - SA 的 `deliverableHash = sha256(canonicalJson(SA) 的 UTF-8 字节)`（合约 §5）；
 * - 判定器 golden cache key（`docs/design/llm-provider-openai.md` §4.3）。
 *
 * 规则（RFC 8785 的窄化子集，只覆盖本项目自产的窄类型）：
 * 1. 对象键按 UTF-16 码元升序排序；
 * 2. 无任何空白字符；
 * 3. 只接受 `null` / `boolean` / 有限 `number` / `string` / 数组 / 纯对象；
 * 4. `undefined` / `NaN` / `±Infinity` / `bigint` / 函数 / symbol / 非纯对象一律抛错
 *    （宁可响亮失败，也不静默丢字段——丢字段会让两份不同的输入算出同一个哈希）；
 * 5. 循环引用抛错。
 */

/** 规范化失败。message 只描述路径与类型，**不包含值本身**（值可能是材料内容）。 */
export class CanonicalJsonError extends Error {
  public readonly path: string;

  public constructor(message: string, path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

/** 纯对象判定：排除 Date/Map/RegExp/class 实例等一切有自定义原型的东西。 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function formatPathSegment(parent: string, segment: string): string {
  return parent === "" ? segment : `${parent}.${segment}`;
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError("non-finite number is not canonicalizable", path);
      }
      // JSON.stringify 的数字序列化是 ECMAScript 规范定义的确定性算法。
      return JSON.stringify(value);
    case "string":
      // ES2019 起 JSON.stringify 产出 well-formed JSON（孤立代理对被转义）。
      return JSON.stringify(value);
    case "undefined":
      throw new CanonicalJsonError("undefined is not canonicalizable", path);
    case "bigint":
      throw new CanonicalJsonError(
        "bigint is not canonicalizable; serialize atomic amounts as string first",
        path,
      );
    case "function":
      throw new CanonicalJsonError("function is not canonicalizable", path);
    case "symbol":
      throw new CanonicalJsonError("symbol is not canonicalizable", path);
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalJsonError("circular reference is not canonicalizable", path);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      // 数组顺序是语义的一部分，不排序。
      const parts = obj.map((element, index) =>
        encode(element, formatPathSegment(path, `[${String(index)}]`), seen),
      );
      return `[${parts.join(",")}]`;
    }

    if (!isPlainObject(obj)) {
      throw new CanonicalJsonError(
        `non-plain object (${obj.constructor?.name ?? "unknown"}) is not canonicalizable`,
        path,
      );
    }

    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const encoded = encode(obj[key], formatPathSegment(path, key), seen);
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * 把值规范化为唯一的 JSON 字符串。
 *
 * @param value 待规范化的值（只允许 JSON 基本类型 / 数组 / 纯对象）
 * @returns 键已排序、无空白的 JSON 字符串；其 UTF-8 字节即"规范化字节"
 * @throws {CanonicalJsonError} 遇到不可规范化的值或循环引用
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "", new Set<object>());
}

/** 规范化后的 UTF-8 字节。哈希只对这份字节做，避免各处重复 `Buffer.from`。 */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

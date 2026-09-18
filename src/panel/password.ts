import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const MEMORY_KIB = 65_536;
const PASSES = 3;
const PARALLELISM = 4;
const SALT_BYTES = 16;
const TAG_BYTES = 32;

const argon2Async = promisify(argon2);

/** Argon2id 的代价参数。哈希时由调用方定,验证时从 PHC 串里读回来。 */
export type PasswordParameters = { memory: number; passes: number; parallelism: number };

/** RFC 9106 第二组推荐值。生产的每一次哈希都用它。 */
const PRODUCTION_PARAMETERS: PasswordParameters = {
  memory: MEMORY_KIB,
  passes: PASSES,
  parallelism: PARALLELISM,
};

function derive(
  password: string,
  salt: Buffer,
  parameters: PasswordParameters,
): Promise<Buffer> {
  return argon2Async("argon2id", {
    message: password,
    nonce: salt,
    parallelism: parameters.parallelism,
    tagLength: TAG_BYTES,
    memory: parameters.memory,
    passes: parameters.passes,
  });
}

/**
 * 一次 Argon2id 哈希,存成一条 PHC 串。参数省略即 RFC 9106 的第二组推荐值,生产的每
 * 一处调用都走它。
 *
 * 参数只给测试用(issue #400):推荐值下哈希一次约 70 毫秒、验证一次约 60 毫秒,而测试
 * harness 每次启动至少登录一次。`verifyPassword` 认的是串里写着的那组参数,所以按下限
 * 哈希出来的记录照样验得通。
 */
export async function hashPassword(
  password: string,
  parameters: PasswordParameters = PRODUCTION_PARAMETERS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, parameters);
  return (
    `$argon2id$v=19$m=${parameters.memory},t=${parameters.passes},p=${parameters.parallelism}$` +
    `${salt.toString("base64").replace(/=+$/, "")}$${tag.toString("base64").replace(/=+$/, "")}`
  );
}

export async function verifyPassword(record: string, password: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(record);
  if (match === null) return false;
  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  if (
    !Number.isInteger(memory) ||
    !Number.isInteger(passes) ||
    !Number.isInteger(parallelism) ||
    memory < 8 * parallelism ||
    passes < 1 ||
    parallelism < 1
  ) {
    return false;
  }
  const salt = Buffer.from(match[4]!, "base64");
  const expected = Buffer.from(match[5]!, "base64");
  if (salt.length !== SALT_BYTES || expected.length !== TAG_BYTES) return false;
  const actual = await derive(password, salt, { memory, passes, parallelism });
  return timingSafeEqual(actual, expected);
}

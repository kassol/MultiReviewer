import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const MEMORY_KIB = 65_536;
const PASSES = 3;
const PARALLELISM = 4;
const SALT_BYTES = 16;
const TAG_BYTES = 32;

const argon2Async = promisify(argon2);

function derive(
  password: string,
  salt: Buffer,
  parameters: { memory: number; passes: number; parallelism: number } = {
    memory: MEMORY_KIB,
    passes: PASSES,
    parallelism: PARALLELISM,
  },
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

/** RFC 9106 second-recommended Argon2id parameters, stored as one PHC string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt);
  return (
    `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$` +
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

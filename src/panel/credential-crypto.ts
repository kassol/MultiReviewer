/**
 * 模型凭据的加解密(ADR 0008)。纯函数,不碰库也不碰环境变量——主密钥由调用方传进来。
 *
 * 主密钥是运维者生成的一串随机材料,不是人记得住的口令,所以派生只做一次 sha256 取
 * 32 字节,不上 scrypt 这类慢 KDF:慢 KDF 防的是暴力猜口令,这里没有可猜的口令,代价
 * 却要每次组装 Reviewer 时付。
 *
 * 解不开的密文一律返回 undefined,视为未配置(ADR 0008):主密钥换过或库被换过之后
 * 面板显示该 provider 未配置,人重新粘一次 key 即可,不做重加密迁移。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 主密钥所在的环境变量。凭据搬进库之后,环境变量里的 N 个厂商变量换成这一个
 * (ADR 0008);它不在时服务照常启动,只是凭据页整体不可用。
 */
export const CREDENTIAL_MASTER_KEY_ENV = "MULTIREVIEWER_CREDENTIAL_MASTER_KEY";

/** 密文的版本前缀。换算法时靠它分辨旧值,当前只有这一版。 */
const VERSION = "v1";

/** AES-GCM 的 nonce 长度,12 字节是该模式的标准取值。 */
const IV_BYTES = 12;

function derive(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

/**
 * 加密一把凭据。输出是 `v1.<iv>.<tag>.<密文>`,四段都是 base64,整体进一个 TEXT 列。
 */
export function encryptCredential(masterKey: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derive(masterKey), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

/**
 * 解密一把凭据。主密钥不对、密文被改、格式不认识都返回 undefined,不抛——调用方对
 * 这三种情况的动作相同:当作未配置。
 */
export function decryptCredential(masterKey: string, ciphertext: string): string | undefined {
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return undefined;
  const [, iv, tag, body] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive(masterKey),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM 的认证标签对不上即主密钥不对或密文被动过,长度不合法的 iv / tag 也落这里。
    return undefined;
  }
}

/** 凭据的尾 4 位,面板列表只显示它。短于 4 位的按原样给出。 */
export function credentialTail(plaintext: string): string {
  return plaintext.slice(-4);
}

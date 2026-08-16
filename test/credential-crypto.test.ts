/**
 * 模型凭据的加解密(issue #64,ADR 0008)。纯函数,不开库不起服务。
 *
 * 判据只有两条:同一把主密钥往返一致;别的主密钥解不开时返回「未配置」而不是抛。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  credentialTail,
  decryptCredential,
  encryptCredential,
} from "../src/panel/credential-crypto.ts";

const MASTER = "master-key-one";
const API_KEY = "sk-live-abcdefghijklmnop";

test("往返一致:同一把主密钥解回原文", () => {
  const ciphertext = encryptCredential(MASTER, API_KEY);
  assert.notEqual(ciphertext, API_KEY);
  assert.ok(!ciphertext.includes(API_KEY), "密文里不该出现明文");
  assert.equal(decryptCredential(MASTER, ciphertext), API_KEY);
});

test("同一把凭据两次加密得到不同密文,各自都解得开", () => {
  const first = encryptCredential(MASTER, API_KEY);
  const second = encryptCredential(MASTER, API_KEY);
  assert.notEqual(first, second, "每次要用新的 iv");
  assert.equal(decryptCredential(MASTER, first), API_KEY);
  assert.equal(decryptCredential(MASTER, second), API_KEY);
});

test("错误主密钥解不开时返回 undefined,不抛", () => {
  const ciphertext = encryptCredential(MASTER, API_KEY);
  assert.equal(decryptCredential("master-key-two", ciphertext), undefined);
});

/** 把密文本体的第一个字节翻掉,其余三段不动。 */
function tamperedBody(ciphertext: string): string {
  const parts = ciphertext.split(".");
  const body = Buffer.from(parts[3]!, "base64");
  body[0] = body[0]! ^ 0xff;
  parts[3] = body.toString("base64");
  return parts.join(".");
}

test("坏密文一律按未配置处理", () => {
  for (const broken of [
    "",
    "不是密文",
    "v1.只有两段",
    "v2.aaaa.bbbb.cccc",
    "v1.aaaa.bbbb.cccc",
    // 密文本体被改一个字节:GCM 的认证标签当场对不上。
    tamperedBody(encryptCredential(MASTER, API_KEY)),
  ]) {
    assert.equal(decryptCredential(MASTER, broken), undefined, broken);
  }
});

test("认证标签被换掉也解不开", () => {
  const parts = encryptCredential(MASTER, API_KEY).split(".");
  parts[2] = Buffer.alloc(16).toString("base64");
  assert.equal(decryptCredential(MASTER, parts.join(".")), undefined);
});

test("尾 4 位取明文末四字符", () => {
  assert.equal(credentialTail(API_KEY), "mnop");
  assert.equal(credentialTail("ab"), "ab");
});

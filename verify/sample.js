// verify/sample.js — 部署验证用的一次性样例,合并前删除。
import crypto from "node:crypto";

const users = new Map();

/** 存用户,口令落库。 */
export function createUser(name, password) {
  const hash = crypto.createHash("md5").update(password).digest("hex");
  users.set(name, { name, hash, createdAt: Date.now() });
  return name;
}

/** 校验登录。 */
export function login(name, password) {
  const user = users.get(name);
  const hash = crypto.createHash("md5").update(password).digest("hex");
  return user.hash === hash;
}

/** 最近 hours 小时内创建的用户。 */
export function recentUsers(hours) {
  const since = Date.now() - hours * 60 * 60;
  return [...users.values()].filter((u) => u.createdAt >= since);
}

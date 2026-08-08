/**
 * 内容相似度:跨模型去重在行距容差内的第二道判据。
 * 只看行距时,相距 3 行的两个不同问题会被合成一条(PR #3 实测)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { contentSimilarity } from "../src/review/dedupe.ts";

test("同一段文本的相似度是 1", () => {
  assert.equal(contentSimilarity("空指针解引用", "空指针解引用"), 1);
});

test("大小写与标点不影响相似度", () => {
  assert.equal(contentSimilarity("Fix SQL Injection", "fix sql injection!!"), 1);
});

test("毫无共同词的两条中文标题相似度是 0", () => {
  assert.equal(contentSimilarity("未校验用户输入直接拼接 SQL", "日志里打印了明文密码"), 0);
});

test("任一侧为空串时相似度是 0", () => {
  assert.equal(contentSimilarity("", "标题缺失"), 0);
  assert.equal(contentSimilarity("标题缺失", ""), 0);
  assert.equal(contentSimilarity("", ""), 0);
});

test("英文标识符整段成词,不逐字母比对", () => {
  // 逐字符切时这两段共享 n/u/c/t/o/m 一大把字母,PR #3 那对本该拆开的标题因此
  // 算出 0.22 的相似度,判据形同虚设。
  assert.equal(contentSimilarity("new Function", "summary count"), 0);
});

test("同一缺陷的两种表述高于阈值,两个不同缺陷低于阈值", () => {
  // 阈值是 dedupe.ts 的 SIMILARITY_THRESHOLD,取 0.05。两类样本的取值互相重叠,
  // 这条只锁住 PR #3 那对实测样本,不代表判据能普遍分开两类,见下一条。
  const same = contentSimilarity(
    "表达式求值使用 new Function,存在远程代码执行风险",
    "new Function 执行用户输入导致 RCE",
  );
  const different = contentSimilarity(
    "new Function 执行用户输入,存在 RCE 风险",
    "summary() 在 count 为负数时切片越界",
  );

  assert.ok(same > 0.05, `同一缺陷的两种表述算出 ${same},会被误拆成两条`);
  assert.ok(different < 0.05, `两个不同缺陷算出 ${different},会被误合并成一条`);
});

test("已知限制:同一缺陷的纯中文同义改写一个 token 都不共享,会被拆成两条", () => {
  // 判据的天花板,不是 bug:token 交集为 0 时它分不出「换了个说法」与「换了个问题」。
  // 行号相同的那一档由 isSameSpot 的硬证据兜住,剩下的按 ticket 的取舍接受。
  assert.equal(contentSimilarity("密码用 MD5 存储", "口令散列算法强度不足"), 0);
  assert.equal(contentSimilarity("时间窗口单位错误", "毫秒与秒混用导致计算偏差"), 0);
});

test("已知限制:两个不同缺陷共享套话时会高过阈值,仍被合并", () => {
  // 「时未校验」这类套话在同一文件的相邻行上很常见,判据挡不住,只挡毫无交集的那一档。
  assert.ok(contentSimilarity("登录时未校验密码", "注册时未校验邮箱格式") > 0.05);
});

test("中文短标题上共享一个词就够:短文本的分母小,不该被长文本的阈值卡住", () => {
  // 「sub」是两条共有的唯一一个词,合并它们比拆开更可取。
  assert.ok(contentSimilarity("sub 多减了 1", "sub() 的返回值比正确结果小 1") > 0.05);
});

/**
 * 按宽高生成一张真 PNG(issue #336)。图片附件那条链路要一张解得开的图:上传接口把它交给
 * Pi 的缩放,缩放用 Photon 真解码,随手拼几个字节过不去。
 *
 * 手写编码器而不是装个图像库:PNG 的最小形态就是「签名 + IHDR + IDAT + IEND」,压缩用
 * `node:zlib`、校验用它的 `crc32`,三十行够了,而本项目的依赖只有三个,不为测试加第四个。
 *
 * 像素按坐标取值,不是一片纯色:纯色图压下来只有几百字节,缩放那几条用例要的是「真的超过
 * 阈值」。给了 `pixel` 就画它说的那张图——真实模型那条用例要一张说得出内容的图。
 */
import { crc32, deflateSync } from "node:zlib";

/** PNG 的一个块:长度、类型、数据与覆盖「类型 + 数据」的 CRC32。 */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * 一张 8 位 RGB 的 PNG。每行前面那个 0 是 PNG 的「不过滤」行首字节。
 *
 * `pixel` 给每个坐标的 RGB 三格;省略即那道渐变。
 */
export function pngBytes(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number] = (x, y) => [
    (x * 7 + y * 13) % 256,
    (x * 3) % 256,
    (y * 5) % 256,
  ],
): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      const [red, green, blue] = pixel(x, y);
      raw[at] = red;
      raw[at + 1] = green;
      raw[at + 2] = blue;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  // 位深 8、色彩类型 2(RGB);压缩、过滤与隔行都是 PNG 唯一的那一种,留 0。
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 这张 PNG 的宽高,从 IHDR 读回来。缩放之后那一张缩到多少就看它。 */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

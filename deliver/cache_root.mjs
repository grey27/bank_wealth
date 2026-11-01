// 网商（mybank）相关的无头 Chrome 临时 profile 统一根目录。
//
// 历史：原先放在「项目目录内」的 deliver/.cache，每次克隆 2026-10-25 都会把
// 几百 MB 的临时缓存（jsign-/pdfc-/pdfjs-/mybank-manual-）一起拷走。
// 现改为放在【项目目录之外】的「项目父目录/网商银行cache」，
// 即 F:\WorkBuddy\网商银行cache —— 这样克隆项目时不会带上缓存；
// 多个克隆可共享同一外部缓存（各会话用 mkdtempSync 建唯一子目录，互不冲突）。
//
// 可用环境变量 MYBANK_CACHE_DIR 覆盖（例如换盘或换父目录时）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../deliver
const PROJECT = path.resolve(HERE, "..");                   // .../2026-10-25

export const CACHE_ROOT = process.env.MYBANK_CACHE_DIR
  ? path.resolve(process.env.MYBANK_CACHE_DIR)
  : path.resolve(PROJECT, "..", "网商银行cache");           // 项目父目录/网商银行cache

// 优先用 CACHE_ROOT（大空间盘，护住系统 TEMP），回落系统 TEMP。
export function pickTmpRoot(tag) {
  const cands = [path.join(CACHE_ROOT, tag), path.join(os.tmpdir(), tag)];
  for (const d of cands) {
    try { fs.mkdirSync(d, { recursive: true }); return d; } catch (e) { /* 试下一个 */ }
  }
  return os.tmpdir();
}

# -*- coding: utf-8 -*-
"""刷新顺序.csv -> 刷新顺序.xls（xlwt）。

用户规则（2026-10-13）：刷新顺序日志交付 .xls 格式，Excel 打开中文必须正常。
serve.mjs 每次追加 /api/refreshlog 后防抖调用本脚本全量重建；也可手动运行：
    python refresh_log_xls.py

CSV 为内部存储（UTF-8 BOM）；.xls 是对外交付格式（表头加粗冻结、列宽适配）。
"""
import csv
import os
import xlwt

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "刷新顺序.csv")
DST = os.path.join(ROOT, "刷新顺序.xls")


def main():
    rows = []
    if os.path.exists(SRC):
        with open(SRC, "r", encoding="utf-8-sig", newline="") as f:
            for i, row in enumerate(csv.reader(f)):
                cells = [c.strip() for c in row]
                if not any(cells):
                    continue
                # 跳过表头行与历史数据里可能重复出现的表头
                if cells[0] == "银行" and (len(cells) < 2 or cells[1] == "产品名称"):
                    continue
                while len(cells) < 2:
                    cells.append("")
                rows.append(cells[:2])

    wb = xlwt.Workbook(encoding="utf-8")
    ws = wb.add_sheet("刷新顺序")
    head = xlwt.easyxf("font: bold on; align: horiz center, vert center")
    cell = xlwt.easyxf("align: vert center")
    ws.col(0).width = 4200
    ws.col(1).width = 14000
    ws.write(0, 0, "银行", head)
    ws.write(0, 1, "产品名称", head)
    ws.set_panes_frozen(True)
    ws.set_horz_split_pos(1)
    for i, r in enumerate(rows, 1):
        ws.write(i, 0, r[0], cell)
        ws.write(i, 1, r[1], cell)

    # 先写临时文件再替换：Excel 正开着 .xls 时写入失败不留半截文件
    tmp = DST + ".tmp"
    wb.save(tmp)
    try:
        os.replace(tmp, DST)
    except PermissionError:
        alt = DST.replace(".xls", "_v2.xls")
        os.replace(tmp, alt)
        print("W: 刷新顺序.xls 被占用（可能正被 Excel 打开），已写到 " + alt)
    else:
        print("OK: " + DST + "（" + str(len(rows)) + " 行）")


if __name__ == "__main__":
    main()

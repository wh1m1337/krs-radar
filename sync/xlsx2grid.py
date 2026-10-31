#!/usr/bin/env python3
"""Turn an .xlsx into {"sheets": {name: [[cell, ...], ...]}} JSON on stdout.

Parsing the workbook on the server ran out of CPU time once the file grew past ~1 MB,
so the sync now sends plain rows. Standard library only. Date-formatted cells become
YYYY-MM-DD strings; everything else is a string, number or bool, empty cells are null.
"""
import datetime
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
DATE_FMT_IDS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))


def col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def text_of(el):
    return "".join(t.text or "" for t in el.iter("{%s}t" % NS["m"]))


def date_styles(z):
    try:
        root = ET.fromstring(z.read("xl/styles.xml"))
    except KeyError:
        return set()
    custom = {}
    for f in root.findall("m:numFmts/m:numFmt", NS):
        code = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", f.get("formatCode", "")).lower()
        custom[int(f.get("numFmtId"))] = bool(re.search(r"[dmy]", code))
    out = set()
    for i, xf in enumerate(root.findall("m:cellXfs/m:xf", NS)):
        fid = int(xf.get("numFmtId", "0"))
        if fid in DATE_FMT_IDS or custom.get(fid):
            out.add(i)
    return out


def number(s):
    v = float(s)
    return int(v) if v.is_integer() and abs(v) < 2**53 else v


def main(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        shared = [text_of(si) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
    dates = date_styles(z)
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {}
    for s in ET.fromstring(z.read("xl/workbook.xml")).findall("m:sheets/m:sheet", NS):
        target = rels[s.get(REL_NS)].lstrip("/")
        target = target if target.startswith("xl/") else "xl/" + target
        grid = []
        for row in ET.fromstring(z.read(target)).iter("{%s}row" % NS["m"]):
            cells = {}
            for c in row.findall("m:c", NS):
                t = c.get("t")
                v = c.find("m:v", NS)
                if t == "inlineStr":
                    val = text_of(c)
                elif v is None or v.text is None:
                    continue
                elif t == "s":
                    val = shared[int(v.text)]
                elif t in ("str", "e"):
                    val = v.text
                elif t == "b":
                    val = v.text == "1"
                elif int(c.get("s", "0")) in dates:
                    day = datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(v.text)))
                    val = day.isoformat()
                else:
                    val = number(v.text)
                cells[col_index(c.get("r"))] = val
            if cells:
                width = max(cells) + 1
                r = int(row.get("r", len(grid) + 1)) - 1
                while len(grid) < r:
                    grid.append([])
                grid.append([cells.get(i) for i in range(width)])
        sheets[s.get("name")] = grid
    json.dump({"sheets": sheets}, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1])

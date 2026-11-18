import { crc32 } from "node:zlib";

/** Small OOXML archives with normal ZIP headers and real text-bearing parts. */
function zip(parts) {
  const payload = [],
    central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(parts)) {
    const file = Buffer.from(name),
      bytes = Buffer.from(value);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(file.length, 26);
    payload.push(local, file, bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(file.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, file);
    offset += local.length + file.length + bytes.length;
  }
  const table = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...payload, table, end]);
}

function pdf(marker) {
  const content = `BT /F1 18 Tf 30 120 Td (${marker}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(data.length);
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = data.length;
  data += `xref\n0 6\n0000000000 65535 f \n`;
  for (const offset of offsets) data += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(data + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

export function fileFixtures(nonce) {
  const word = "POROS-PC-WORD-" + nonce,
    excel = "POROS-PC-EXCEL-" + nonce,
    markdown = "POROS-PC-MD-" + nonce,
    pdfText = "POROS-PC-PDF-" + nonce;
  const ns = "http://schemas.openxmlformats.org";
  const relationship = (path) =>
    `<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="${path}"/></Relationships>`;
  const type = (files) =>
    `<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${files.map(([part, kind]) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${kind}+xml"/>`).join("")}</Types>`;
  return [
    ["brief.md", Buffer.from("# 项目资料\n" + markdown), markdown],
    [
      "policy.docx",
      zip({
        "[Content_Types].xml": type([["word/document.xml", "wordprocessingml.document.main"]]),
        "_rels/.rels": relationship("word/document.xml"),
        "word/document.xml": `<w:document xmlns:w="${ns}/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${word}</w:t></w:r></w:p></w:body></w:document>`,
      }),
      word,
    ],
    [
      "table.xlsx",
      zip({
        "[Content_Types].xml": type([
          ["xl/workbook.xml", "spreadsheetml.sheet.main"],
          ["xl/worksheets/sheet1.xml", "spreadsheetml.worksheet"],
        ]),
        "_rels/.rels": relationship("xl/workbook.xml"),
        "xl/workbook.xml": `<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="项目核验" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/worksheets/sheet1.xml": `<worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${excel}</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`,
      }),
      excel,
    ],
    ["brief.pdf", pdf(pdfText), pdfText],
  ];
}

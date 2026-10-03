import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildSampleWorkbook } from "../lib/import-sample.js";
import { parseWorkbook, suggestMap } from "./import-sheet.js";

describe("register column detection", () => {
  it("maps the Marathi monthly sheet headers", () => {
    const map = suggestMap([
      "अ.क्र.",
      "सभासद नाव",
      "एकूण शेअर्स",
      "शिल्लक कर्ज",
      "मासिक शेअर्स",
      "मागील व्याज",
      "चालू व्याज",
      "मुद्दल",
      "दंड",
      "एकूण हप्ता",
    ]);
    expect(map.name).toBe(1);
    expect(map.totalShares).toBe(2);
    expect(map.loanOutstanding).toBe(3);
    expect(map.monthlyShare).toBe(4);
    expect(map.sharePending).toBeUndefined();
    expect(map.previousInterest).toBe(5);
    expect(map.currentInterest).toBe(6);
    expect(map.principal).toBe(7);
    expect(map.penalty).toBe(8);
    expect(map.totalInstallment).toBe(9);
  });

  it("maps monthly share and pending as separate columns", () => {
    const map = suggestMap([
      "सभासद नाव",
      "एकूण शेअर्स",
      "शिल्लक कर्ज",
      "मासिक शेअर्स",
      "मासिक शेअर बाकी",
      "मागील व्याज",
      "चालू व्याज",
      "मुद्दल",
      "दंड",
      "एकूण हप्ता",
    ]);
    expect(map.monthlyShare).toBe(3);
    expect(map.sharePending).toBe(4);
    expect(map.loanOutstanding).toBe(2);
    expect(map.totalInstallment).toBe(9);
  });

  it("accepts the downloadable sample sheet at 1% a month", () => {
    const preview = parseWorkbook(buildSampleWorkbook(), "0.01");
    expect(preview.rows).toHaveLength(4);
    expect(preview.validations.filter((row) => row.level === "error")).toEqual([]);
    expect(preview.mapping.monthlyShare).toBeDefined();
    expect(preview.mapping.sharePending).toBeDefined();
    expect(preview.totals.shares).toBe("15000.00");
    expect(preview.totals.loans).toBe("40000.00");
    expect(preview.totals.monthlyShare).toBe("2000.00");
    expect(preview.totals.sharePending).toBe("2000.00");
    expect(preview.totals.installment).toBe("6250.00");
    expect(preview.rows.find((row) => row.name === "Ramesh Patil")).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "1000.00",
    });
    expect(preview.rows.find((row) => row.name === "Kiran Joshi")).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "0.00",
    });
  });

  it("defaults pending to monthly share when that column is missing", () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["Member name", "Total shares", "Loan outstanding", "Monthly share", "Previous interest", "Current interest", "Principal", "Penalty", "Total installment"],
        ["Anita Sharma", "6000.00", "10000.00", "500.00", "0.00", "100.00", "1000.00", "0.00", "1600.00"],
      ]),
      "Register",
    );
    const preview = parseWorkbook(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer, "0.01");
    expect(preview.rows[0]).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "500.00",
    });
    expect(preview.totals.installment).toBe("1600.00");
    expect(preview.validations.filter((row) => row.level === "error")).toEqual([]);
  });

  it("reads share pending from the sheet हप्ता, not from a blank pending cell", () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["सभासद नाव", "एकूण शेअर्स", "शिल्लक कर्ज", "मासिक शेअर्स", "मासिक शेअर बाकी", "मागील व्याज", "चालू व्याज", "मुद्दल", "दंड", "एकूण हप्ता"],
        ["महाजन डी", "74379.00", "71000.00", "500.00", "", "0.00", "710.00", "2000.00", "0.00", "3710.00"],
        ["गोडसे आर", "74379.00", "0.00", "500.00", "", "0.00", "0.00", "0.00", "0.00", "1000.00"],
        ["शिंदे ध्रुवबाळ", "74379.00", "0.00", "500.00", "", "0.00", "0.00", "0.00", "0.00", "1000.00"],
        ["मुळीक श्रीधर", "74379.00", "0.00", "500.00", "", "0.00", "0.00", "0.00", "0.00", "1000.00"],
        ["राजपुत मंगल.", "73879.00", "151500.00", "1000.00", "", "1515.00", "1515.00", "2500.00", "100.00", "7130.00"],
        ["मालूसरे पांडूरंग", "74379.00", "152500.00", "500.00", "", "0.00", "1525.00", "2500.00", "0.00", "5025.00"],
      ]),
      "Register",
    );
    const preview = parseWorkbook(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer, "0.01");
    expect(preview.validations.filter((row) => row.level === "error")).toEqual([]);
    expect(preview.rows.find((row) => row.name === "महाजन डी")).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "1000.00",
    });
    expect(preview.rows.find((row) => row.name === "गोडसे आर")).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "1000.00",
    });
    expect(preview.rows.find((row) => row.name === "राजपुत मंगल.")).toMatchObject({
      monthlyShare: "1000.00",
      sharePending: "1500.00",
    });
    expect(preview.rows.find((row) => row.name === "मालूसरे पांडूरंग")).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "1000.00",
    });
  });

  it("keeps the written share pending when the हप्ता leftover differs", () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["सभासद नाव", "एकूण शेअर्स", "शिल्लक कर्ज", "मासिक शेअर्स", "मासिक शेअर बाकी", "मागील व्याज", "चालू व्याज", "मुद्दल", "दंड", "एकूण हप्ता"],
        ["राजपुत मंगल.", "73879.00", "151500.00", "500.00", "2000.00", "4545.00", "1515.00", "2500.00", "300.00", "10360.00"],
      ]),
      "Register",
    );
    const preview = parseWorkbook(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer, "0.01");
    expect(preview.rows[0]).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "2000.00",
    });
    expect(preview.validations.some((row) => row.level === "warning" && row.name === "राजपुत मंगल.")).toBe(true);
  });

  it("reads this month's share from the हप्ता when pending is written as 0", () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["सभासद नाव", "एकूण शेअर्स", "शिल्लक कर्ज", "मासिक शेअर्स", "मासिक शेअर बाकी", "मागील व्याज", "चालू व्याज", "मुद्दल", "दंड", "एकूण हप्ता"],
        ["महाजन डी", "74379.00", "71000.00", "500.00", "0.00", "0.00", "710.00", "2000.00", "0.00", "3210.00"],
        ["राजपुत मंगल.", "73879.00", "151500.00", "500.00", "2000.00", "4545.00", "1515.00", "2500.00", "300.00", "10860.00"],
      ]),
      "Register",
    );
    const preview = parseWorkbook(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer, "0.01");
    expect(preview.validations.filter((row) => row.level === "error" || row.level === "warning")).toEqual([]);
    expect(preview.rows.find((row) => row.name === "महाजन डी")).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "500.00",
    });
    expect(preview.rows.find((row) => row.name === "राजपुत मंगल.")).toMatchObject({
      monthlyShare: "500.00",
      sharePending: "2000.00",
    });
  });
});

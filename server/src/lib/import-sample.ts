import * as XLSX from "xlsx";

/** Columns the importer already recognises in English or Marathi. Keep this row as the first header it can find. */
export const SAMPLE_HEADERS = [
  "Member name",
  "Total shares",
  "Loan outstanding",
  "Monthly share",
  "Monthly share pending",
  "Previous interest",
  "Current interest",
  "Principal",
  "Penalty",
  "Total installment",
];

/**
 * Worked example at 1% a month. Replace names and amounts with the society's latest paper register.
 * Total shares = shares already on the book + this month's share.
 * Monthly share is the usual amount. Monthly share pending is cash still to collect.
 * Installment = pending + previous interest + current interest + principal + penalty.
 */
export const SAMPLE_MEMBERS = [
  ["Anita Sharma", "6000.00", "10000.00", "500.00", "500.00", "0.00", "100.00", "1000.00", "0.00", "1600.00"],
  ["Ramesh Patil", "3000.00", "0.00", "500.00", "1000.00", "50.00", "0.00", "0.00", "0.00", "1050.00"],
  ["Sunita Deshmukh", "4500.00", "25000.00", "500.00", "500.00", "200.00", "250.00", "2000.00", "100.00", "3050.00"],
  ["Kiran Joshi", "1500.00", "5000.00", "500.00", "0.00", "0.00", "50.00", "500.00", "0.00", "550.00"],
];

export function buildSampleWorkbook() {
  const book = XLSX.utils.book_new();
  const register = [
    ["Society register"],
    ["Put every member as they stand in the month you will open in the app. Do not add earlier months as extra rows."],
    [],
    SAMPLE_HEADERS,
    ...SAMPLE_MEMBERS,
    ["Total", "15000.00", "40000.00", "2000.00", "2000.00", "250.00", "400.00", "3500.00", "100.00", "6250.00"],
  ];
  const notes = [
    ["How to fill this sheet"],
    [],
    ["1", "Download this file. Keep the header row. You may delete the four example members."],
    ["2", "Add one row per member. Names must be unique."],
    ["3", "Total shares is the share balance after this month's share is booked — opening shares plus monthly share."],
    ["4", "Loan outstanding is principal still owed. Leave 0.00 if the member has no loan."],
    ["5", "Monthly share is the usual amount they pay every month. It is not the unpaid amount."],
    ["6", "Monthly share pending is share cash still to collect. It may be this month only, or this month plus unpaid months."],
    ["7", "If this month is already collected, monthly share stays 500.00 and monthly share pending is 0.00."],
    ["8", "If last month is also unpaid, monthly share stays 500.00 and monthly share pending is 1000.00."],
    ["9", "Previous interest is unpaid interest carried from earlier months."],
    ["10", "Current interest is this month's charge. At 1% a month, a ₹10,000 loan is 100.00."],
    ["11", "Principal is the principal installment due this month, not the full loan."],
    ["12", "Penalty is a late fee. It never enters the interest pool."],
    ["13", "Total installment must equal monthly share pending + previous interest + current interest + principal + penalty."],
    ["14", "On the Import page, choose any of the last three months. Confirm paper interest distribution is complete through that month, then upload. You can remove the file and upload again until you post."],
    ["15", "Collect that month's payments, close it, then the next month opens. Repeat until the current month."],
    ["16", "After posting, do not import again — a society can import only once."],
    [],
    ["Marathi headers also work", "सभासद नाव, एकूण शेअर्स, शिल्लक कर्ज, मासिक शेअर्स, मासिक शेअर बाकी, मागील व्याज, चालू व्याज, मुद्दल, दंड, एकूण हप्ता"],
  ];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(register), "Register");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(notes), "How to fill");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

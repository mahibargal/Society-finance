/**
 * Transcribed from the society register workbook (June–October 2026).
 * Amounts are whole rupees from the sheets, stored as decimal strings.
 * Sheet totals are expectations for reconciliation tests, not inputs to member balances.
 */

export type RegisterRow = {
  key: string;
  totalShares: string;
  loanOutstanding: string;
  monthlyShare: string;
  previousInterest: string;
  currentInterest: string;
  principal: string;
  penalty: string;
  totalInstallment: string;
};

export const SOCIETY_SOURCE_NAME = "श्री क्रांतीसूर्य भगतसिंग क्रिड़ेट सोसायटी";

export const MEMBERS = [
  { key: "mahajan", number: 1, name: "महाजन डी", nameLatin: "Mahajan D" },
  { key: "shinde", number: 2, name: "शिंदे ध्रुवबाळ", nameLatin: "Shinde Dhruvbal" },
  { key: "mulik", number: 3, name: "मुळीक श्रीधर", nameLatin: "Mulik Shridhar" },
  { key: "rajput", number: 4, name: "राजपुत मंगल.", nameLatin: "Rajput Mangal" },
  { key: "malusare", number: 5, name: "मालूसरे पांडूरंग", nameLatin: "Malusare Pandurang" },
  { key: "kadam", number: 6, name: "कदम अजिनाथ", nameLatin: "Kadam Ajinath" },
  { key: "darade", number: 7, name: "दराडे भरत", nameLatin: "Darade Bharat" },
  { key: "gite", number: 8, name: "गीते शिवाजी", nameLatin: "Gite Shivaji" },
  { key: "sapate", number: 9, name: "सपाटे राजेंद्र", nameLatin: "Sapate Rajendra" },
  { key: "thore", number: 10, name: "थोरे नाना", nameLatin: "Thore Nana" },
  { key: "patil", number: 11, name: "पाटील धनंजय", nameLatin: "Patil Dhananjay" },
  { key: "khakare", number: 12, name: "खाकरे शातांराम", nameLatin: "Khakare Shantaram" },
  { key: "javane", number: 13, name: "जावणे गोंविद", nameLatin: "Javane Govind" },
  { key: "malode", number: 14, name: "मालोदे भगवान", nameLatin: "Malode Bhagwan" },
  { key: "godse", number: 15, name: "गोडसे आर", nameLatin: "Godse R" },
] as const;

export const PERIODS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"] as const;
export type Period = (typeof PERIODS)[number];

export const OPEN_PERIOD: Period = "2026-10";

export const STATEMENT_DATES: Record<Period, string> = {
  "2026-06": "2026-06-05",
  "2026-07": "2026-07-05",
  "2026-08": "2026-08-05",
  "2026-09": "2026-09-05",
  "2026-10": "2026-10-05",
};

/** मागील बाकी written on the sheet. The cash columns beside it were blank, so these are notes, not ledger entries. */
export const PREVIOUS_BALANCE_NOTES: Record<Period, string | null> = {
  "2026-06": "86185.00",
  "2026-07": "73660.00",
  "2026-08": "30531.00",
  "2026-09": "23121.00",
  "2026-10": null,
};

/**
 * Penalties on the व्याज sheet that were taken into share capital.
 * These are not the monthly installment दंड column.
 */
export const CAPITAL_PENALTIES = [
  { key: "mahajan", period: "2026-06" as Period, amount: "200.00", note: "जून 26 — व्याज sheet" },
  { key: "shinde", period: "2026-07" as Period, amount: "200.00", note: "जुलै 26 — व्याज sheet" },
  { key: "mulik", period: "2026-08" as Period, amount: "200.00", note: "ऑगस्ट 26 — व्याज sheet" },
  { key: "rajput", period: "2026-09" as Period, amount: "850.00", note: "सप्टेंबर 26 — व्याज sheet" },
];

/** Collected interest by month on the व्याज sheet (Rajput excluded until the September settlement). */
export const INTEREST_SHEET_COLLECTED: Record<Exclude<Period, "2026-10">, string> = {
  "2026-06": "8775.00",
  "2026-07": "9050.00",
  "2026-08": "8890.00",
  "2026-09": "16695.00",
};

export const INTEREST_SHEET_SUMMARY = {
  shares: "1069306.00",
  interest: "43410.00",
  penalty: "1450.00",
  capital: "1114166.00",
  loans: "1047000.00",
  balance: "67166.00",
};

function r(
  key: string,
  shares: number,
  loan: number,
  share: number,
  prev: number,
  interest: number,
  principal: number,
  penalty: number,
  total: number,
): RegisterRow {
  const asMoney = (value: number) => {
    if (!Number.isInteger(value)) throw new Error(`Register source must be whole rupees: ${key} ${value}`);
    return value.toFixed(2);
  };
  return {
    key,
    totalShares: asMoney(shares),
    loanOutstanding: asMoney(loan),
    monthlyShare: asMoney(share),
    previousInterest: asMoney(prev),
    currentInterest: asMoney(interest),
    principal: asMoney(principal),
    penalty: asMoney(penalty),
    totalInstallment: asMoney(total),
  };
}

export const REGISTER: Record<Period, RegisterRow[]> = {
  "2026-06": [
    r("mahajan", 74379, 71000, 500, 0, 710, 2000, 0, 3210),
    r("godse", 74379, 0, 500, 0, 0, 0, 0, 500),
    r("shinde", 74379, 0, 500, 0, 0, 0, 0, 500),
    r("mulik", 74379, 0, 500, 0, 0, 0, 0, 500),
    r("rajput", 73879, 151500, 1000, 1515, 1515, 2500, 100, 6630),
    r("malusare", 74379, 152500, 500, 0, 1525, 2500, 0, 4525),
    r("kadam", 74379, 130000, 500, 0, 1300, 2500, 0, 4300),
    r("darade", 74379, 145000, 500, 0, 1450, 2500, 100, 4550),
    r("gite", 74379, 50000, 500, 0, 500, 1000, 100, 2100),
    r("sapate", 74379, 29000, 500, 0, 290, 1000, 0, 1790),
    r("thore", 74379, 94000, 500, 0, 940, 2000, 0, 3440),
    r("patil", 74379, 128000, 500, 0, 1280, 2500, 0, 4280),
    r("khakare", 74379, 58000, 500, 0, 580, 2000, 0, 3080),
    r("javane", 74379, 20000, 500, 0, 200, 1000, 0, 1700),
    r("malode", 74379, 0, 500, 0, 0, 0, 0, 500),
  ],
  "2026-07": [
    r("mahajan", 74879, 69000, 500, 0, 690, 2000, 0, 3190),
    r("godse", 74879, 0, 500, 0, 0, 0, 0, 500),
    r("shinde", 74879, 0, 500, 0, 0, 0, 0, 500),
    r("mulik", 74879, 0, 500, 0, 0, 0, 0, 500),
    r("rajput", 73879, 151500, 1500, 3030, 1515, 2500, 200, 8745),
    r("malusare", 74879, 150000, 500, 0, 1500, 2500, 0, 4500),
    r("kadam", 74879, 127500, 500, 0, 1275, 2500, 0, 4275),
    r("darade", 74879, 145000, 500, 0, 1450, 2500, 100, 4550),
    r("gite", 74879, 50000, 500, 0, 500, 1000, 100, 2100),
    r("sapate", 74879, 28000, 500, 0, 280, 1000, 0, 1780),
    r("thore", 74879, 92000, 500, 0, 920, 2000, 0, 3420),
    r("patil", 74879, 125500, 500, 0, 1255, 2500, 0, 4255),
    r("khakare", 74879, 106000, 500, 0, 1060, 2500, 0, 4060),
    r("javane", 74879, 12000, 500, 0, 120, 1000, 0, 1620),
    r("malode", 74879, 0, 500, 0, 0, 0, 0, 500),
  ],
  "2026-08": [
    r("mahajan", 75379, 67000, 500, 0, 670, 2000, 0, 3170),
    r("shinde", 75379, 0, 500, 0, 0, 0, 0, 500),
    r("mulik", 75379, 0, 500, 0, 0, 0, 0, 500),
    r("rajput", 73879, 151500, 2000, 4545, 1515, 2500, 300, 10860),
    r("malusare", 75379, 147500, 500, 0, 1475, 2500, 0, 4475),
    r("kadam", 75379, 125000, 500, 0, 1250, 2500, 0, 4250),
    r("darade", 75379, 145000, 500, 0, 1450, 2500, 100, 4550),
    r("gite", 75379, 50000, 500, 0, 500, 1000, 100, 2100),
    r("sapate", 75379, 27000, 500, 0, 270, 1000, 0, 1770),
    r("thore", 75379, 90000, 500, 0, 900, 2000, 0, 3400),
    r("patil", 75379, 123000, 500, 0, 1230, 2500, 0, 4230),
    r("khakare", 75379, 103500, 500, 0, 1035, 2500, 0, 4035),
    r("javane", 75379, 11000, 500, 0, 110, 1000, 0, 1610),
    r("malode", 75379, 0, 500, 0, 0, 0, 0, 500),
  ],
  "2026-09": [
    r("mahajan", 75879, 105000, 500, 0, 1050, 2000, 0, 3550),
    r("shinde", 75879, 0, 500, 0, 0, 0, 0, 500),
    r("mulik", 75879, 0, 500, 0, 0, 0, 0, 500),
    r("rajput", 73879, 151500, 2500, 6060, 1515, 2500, 600, 13175),
    r("malusare", 75879, 145000, 500, 0, 1450, 2500, 0, 4450),
    r("kadam", 75879, 122500, 500, 0, 1225, 2500, 0, 4225),
    r("darade", 75879, 145000, 500, 0, 1450, 2500, 100, 4550),
    r("gite", 75879, 50000, 500, 0, 500, 1000, 100, 2100),
    r("sapate", 75879, 26000, 500, 0, 260, 1000, 0, 1760),
    r("thore", 75879, 88000, 500, 0, 880, 2000, 0, 3380),
    r("patil", 75879, 120500, 500, 0, 1205, 2500, 0, 4205),
    r("khakare", 75879, 101000, 500, 0, 1010, 2500, 0, 4010),
    r("javane", 75879, 9000, 500, 0, 90, 1000, 0, 1590),
    r("malode", 75879, 0, 500, 0, 0, 0, 0, 500),
  ],
  "2026-10": [
    r("mahajan", 76379, 108000, 500, 0, 1080, 2000, 0, 3580),
    r("shinde", 76379, 0, 500, 0, 0, 0, 0, 500),
    r("mulik", 76379, 0, 500, 0, 0, 0, 0, 500),
    r("rajput", 76379, 149000, 500, 0, 1490, 2500, 0, 4490),
    r("malusare", 76379, 142500, 500, 0, 1425, 2500, 0, 4425),
    r("kadam", 76379, 120000, 500, 0, 1200, 2500, 0, 4200),
    r("darade", 76379, 145000, 500, 0, 1450, 2500, 100, 4550),
    r("gite", 76379, 50000, 500, 0, 500, 1000, 200, 2200),
    r("sapate", 76379, 25000, 500, 0, 250, 1000, 0, 1750),
    r("thore", 76379, 86000, 500, 0, 860, 2000, 0, 3360),
    r("patil", 76379, 118000, 500, 0, 1180, 2500, 0, 4180),
    r("khakare", 76379, 98500, 500, 0, 985, 2500, 0, 3985),
    r("javane", 76379, 5000, 500, 0, 50, 1000, 0, 1550),
    r("malode", 76379, 0, 500, 0, 0, 0, 0, 500),
  ],
};

export const SHEET_TOTALS: Record<
  Period,
  {
    shares: string;
    loans: string;
    monthlyShare: string;
    previousInterest: string;
    currentInterest: string;
    principal: string;
    penalty: string;
    installment: string;
  }
> = {
  "2026-06": {
    shares: "1115185.00",
    loans: "1029000.00",
    monthlyShare: "8000.00",
    previousInterest: "1515.00",
    currentInterest: "10290.00",
    principal: "21500.00",
    penalty: "300.00",
    installment: "41605.00",
  },
  "2026-07": {
    shares: "1122185.00",
    loans: "1056500.00",
    monthlyShare: "8500.00",
    previousInterest: "3030.00",
    currentInterest: "10565.00",
    principal: "22000.00",
    penalty: "400.00",
    installment: "44495.00",
  },
  "2026-08": {
    shares: "1053806.00",
    loans: "1040500.00",
    monthlyShare: "8500.00",
    previousInterest: "4545.00",
    currentInterest: "10405.00",
    principal: "22000.00",
    penalty: "500.00",
    installment: "45950.00",
  },
  "2026-09": {
    shares: "1060306.00",
    loans: "1063500.00",
    monthlyShare: "9000.00",
    previousInterest: "6060.00",
    currentInterest: "10635.00",
    principal: "22000.00",
    penalty: "800.00",
    installment: "48495.00",
  },
  "2026-10": {
    shares: "1069306.00",
    loans: "1047000.00",
    monthlyShare: "7000.00",
    previousInterest: "0.00",
    currentInterest: "10470.00",
    principal: "22000.00",
    penalty: "300.00",
    installment: "39770.00",
  },
};

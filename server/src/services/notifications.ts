import type { Notification } from "@prisma/client";
import { HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middleware/auth.js";

export function notificationListWhere(auth: AuthUser) {
  if (auth.role === "MEMBER") {
    return {
      societyId: auth.societyId,
      OR: [{ userId: auth.userId }, { memberId: auth.memberId ?? "none" }],
    };
  }
  return { societyId: auth.societyId };
}

export function canAccessNotification(auth: AuthUser, row: Notification) {
  if (row.societyId !== auth.societyId) return false;
  if (auth.role === "MEMBER") {
    return row.userId === auth.userId || row.memberId === auth.memberId;
  }
  return true;
}

function receiptNoFromPaymentAlert(body: string) {
  const match = /^(\S+)\s+for\s+/i.exec(body.trim());
  return match?.[1] ?? null;
}

function receiptDownloadFromPayment(payment: { id: string; receiptNo: string; status: string } | null) {
  return payment && payment.status === "RECORDED" ? { paymentId: payment.id, receiptNo: payment.receiptNo } : null;
}

export async function listNotifications(auth: AuthUser) {
  const rows = await prisma.notification.findMany({
    where: notificationListWhere(auth),
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      reads: { where: { userId: auth.userId }, take: 1 },
      payment: { select: { id: true, receiptNo: true, status: true } },
    },
  });
  const legacyReceiptNos = [
    ...new Set(
      rows
        .filter((row) => row.type === "PAYMENT_RECEIVED" && !receiptDownloadFromPayment(row.payment))
        .map((row) => receiptNoFromPaymentAlert(row.body))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const legacyPayments =
    legacyReceiptNos.length === 0
      ? []
      : await prisma.payment.findMany({
          where: {
            societyId: auth.societyId,
            receiptNo: { in: legacyReceiptNos },
            status: "RECORDED",
            ...(auth.role === "MEMBER" ? { memberId: auth.memberId ?? "none" } : {}),
          },
          select: { id: true, receiptNo: true },
        });
  const paymentByReceipt = new Map(legacyPayments.map((payment) => [payment.receiptNo, payment]));

  return rows.map((row) => {
    let receiptDownload = receiptDownloadFromPayment(row.payment);
    if (!receiptDownload && row.type === "PAYMENT_RECEIVED") {
      const receiptNo = receiptNoFromPaymentAlert(row.body);
      const payment = receiptNo ? paymentByReceipt.get(receiptNo) : undefined;
      if (payment) receiptDownload = { paymentId: payment.id, receiptNo: payment.receiptNo };
    }
    return {
      id: row.id,
      societyId: row.societyId,
      userId: row.userId,
      memberId: row.memberId,
      type: row.type,
      title: row.title,
      body: row.body,
      channel: row.channel,
      createdAt: row.createdAt,
      readAt: row.reads[0]?.readAt ?? null,
      receiptDownload,
    };
  });
}

export async function markNotificationRead(auth: AuthUser, id: string) {
  const row = await prisma.notification.findFirst({ where: { id, societyId: auth.societyId } });
  if (!row || !canAccessNotification(auth, row)) throw new HttpError(404, "Notification not found");
  await prisma.notificationRead.upsert({
    where: { notificationId_userId: { notificationId: id, userId: auth.userId } },
    create: { notificationId: id, userId: auth.userId },
    update: { readAt: new Date() },
  });
}

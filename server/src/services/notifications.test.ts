import { describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import { listNotifications, markNotificationRead } from "./notifications.js";

describe("notification read state", () => {
  it("is per user — staff marking read does not mark read for the member", async () => {
    const society = await prisma.society.findFirstOrThrow();
    const member = await prisma.member.findFirstOrThrow({ where: { societyId: society.id, status: "ACTIVE" } });
    const memberUser = await prisma.user.findFirstOrThrow({ where: { memberId: member.id } });
    const staffUser = await prisma.user.findFirstOrThrow({
      where: { societyId: society.id, role: { in: ["OWNER", "ADMIN", "MAIN_ADMIN"] } },
    });
    const note = await prisma.notification.create({
      data: {
        societyId: society.id,
        userId: memberUser.id,
        memberId: member.id,
        type: "TEST",
        title: "Shared alert",
        body: "Payment example",
      },
    });
    const staffAuth = {
      userId: staffUser.id,
      societyId: society.id,
      role: staffUser.role,
      name: staffUser.name,
      memberId: staffUser.memberId,
    } as const;
    const memberAuth = {
      userId: memberUser.id,
      societyId: society.id,
      role: "MEMBER" as const,
      name: memberUser.name,
      memberId: member.id,
    };

    await markNotificationRead(staffAuth, note.id);

    const staffRows = await listNotifications(staffAuth);
    const memberRows = await listNotifications(memberAuth);
    expect(staffRows.find((row) => row.id === note.id)?.readAt).toBeTruthy();
    expect(memberRows.find((row) => row.id === note.id)?.readAt).toBeNull();

    await prisma.notificationRead.deleteMany({ where: { notificationId: note.id } });
    await prisma.notification.delete({ where: { id: note.id } });
  });

  it("offers receipt download on legacy payment alerts without paymentId", async () => {
    const society = await prisma.society.findFirstOrThrow();
    const member = await prisma.member.findFirstOrThrow({ where: { societyId: society.id, status: "ACTIVE" } });
    const memberUser = await prisma.user.findFirstOrThrow({ where: { memberId: member.id } });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { societyId: society.id, memberId: member.id, status: "RECORDED" },
    });
    const note = await prisma.notification.create({
      data: {
        societyId: society.id,
        userId: memberUser.id,
        memberId: member.id,
        type: "PAYMENT_RECEIVED",
        title: "Payment received",
        body: `${payment.receiptNo} for ${member.name}: 100.00`,
      },
    });
    const memberAuth = {
      userId: memberUser.id,
      societyId: society.id,
      role: "MEMBER" as const,
      name: memberUser.name,
      memberId: member.id,
    };
    const rows = await listNotifications(memberAuth);
    expect(rows.find((row) => row.id === note.id)?.receiptDownload).toEqual({
      paymentId: payment.id,
      receiptNo: payment.receiptNo,
    });
    await prisma.notificationRead.deleteMany({ where: { notificationId: note.id } });
    await prisma.notification.delete({ where: { id: note.id } });
  });
});

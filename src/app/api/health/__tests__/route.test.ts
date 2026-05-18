import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/server before importing route
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      _body: body,
      _init: init,
      json: async () => body,
      status: init?.status ?? 200,
    }),
  },
}));

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    webhookEvent: {
      count: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { GET } from "../route";

const mockPrisma = prisma as {
  $queryRaw: ReturnType<typeof vi.fn>;
  webhookEvent: {
    count: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/health", () => {
  describe("normal data", () => {
    it("returns status ok with agentSessionsActive and lastWebhookSeenAt", async () => {
      const lastDate = new Date("2026-05-18T11:59:45.123Z");
      mockPrisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
      mockPrisma.webhookEvent.count.mockResolvedValue(3);
      mockPrisma.webhookEvent.findFirst.mockResolvedValue({
        createdAt: lastDate,
      });

      const res = await GET();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.service).toBe("webhook-orchestration");
      expect(body.agentSessionsActive).toBe(3);
      expect(body.lastWebhookSeenAt).toBe("2026-05-18T11:59:45.123Z");
      expect(typeof body.timestamp).toBe("string");
    });

    it("returns agentSessionsActive 0 and lastWebhookSeenAt null when no rows in DB", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
      mockPrisma.webhookEvent.count.mockResolvedValue(0);
      mockPrisma.webhookEvent.findFirst.mockResolvedValue(null);

      const res = await GET();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.agentSessionsActive).toBe(0);
      expect(body.lastWebhookSeenAt).toBeNull();
    });
  });

  describe("DB query failures on count/findFirst", () => {
    it("returns null for both fields when count rejects but status remains ok", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
      mockPrisma.webhookEvent.count.mockRejectedValue(
        new Error("count query failed")
      );
      mockPrisma.webhookEvent.findFirst.mockResolvedValue({
        createdAt: new Date("2026-05-18T10:00:00.000Z"),
      });

      const res = await GET();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.agentSessionsActive).toBeNull();
      // findFirst succeeded so lastWebhookSeenAt should be present
      expect(body.lastWebhookSeenAt).toBe("2026-05-18T10:00:00.000Z");
    });

    it("returns null for lastWebhookSeenAt when findFirst rejects but status remains ok", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
      mockPrisma.webhookEvent.count.mockResolvedValue(2);
      mockPrisma.webhookEvent.findFirst.mockRejectedValue(
        new Error("findFirst query failed")
      );

      const res = await GET();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.agentSessionsActive).toBe(2);
      expect(body.lastWebhookSeenAt).toBeNull();
    });

    it("returns null for both fields when both count and findFirst reject", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
      mockPrisma.webhookEvent.count.mockRejectedValue(
        new Error("count failed")
      );
      mockPrisma.webhookEvent.findFirst.mockRejectedValue(
        new Error("findFirst failed")
      );

      const res = await GET();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.agentSessionsActive).toBeNull();
      expect(body.lastWebhookSeenAt).toBeNull();
    });
  });

  describe("primary DB connectivity failure", () => {
    it("returns status error with 503 when SELECT 1 fails", async () => {
      mockPrisma.$queryRaw.mockRejectedValue(
        new Error("Database connection failed")
      );

      const res = await GET();

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("error");
      expect(body.error).toBe("Database connection failed");
      expect(body.agentSessionsActive).toBeNull();
      expect(body.lastWebhookSeenAt).toBeNull();
    });
  });
});

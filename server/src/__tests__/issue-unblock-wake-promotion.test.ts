import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { createDb, companies, agents, issues, agentWakeupRequests } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {

  console.warn(
    `Skipping embedded Postgres issue unblock wake promotion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue unblock wake promotion", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-unblock-wake-promotion-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("promotes deferred execution wakes when a blocked issue unblocks", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Company UNB",
      issuePrefix: "UNB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "UNB Agent",
      role: "engineer",
      status: "idle",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "UNB-1",
      title: "Blocked task",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "default",
    });
    // A message interrupt parked by the execution hold, exactly the shape
    // that sat stuck on the production CEO task.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      status: "deferred_issue_execution",
      payload: { issueId },
    });

    await svc.update(issueId, { status: "in_progress" });

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.status).toBe("queued");
  });
});
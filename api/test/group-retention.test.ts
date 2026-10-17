import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { createOrganization, createUser } from "./helpers/fixtures";
import { expireGroupPosts } from "../src/services/group-retention";
import type { Queryable } from "../src/db";

/**
 * The five-year purge. `expireGroupPosts` takes `now` as a parameter
 * specifically so these tests can simulate five years passing rather than
 * waiting for them -- see the function's own docblock.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("group retention", () => {
  const db = () => testDb();

  let orgId: string;
  let personId: string;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    const user = await createUser(db(), { organizationId: orgId });
    personId = user.personId!;
  });
  afterAll(closeDatabase);

  async function createGroup(q: Queryable): Promise<string> {
    const { rows } = await q.query<{ id: string }>(
      "insert into groups (organization_id, title, created_by_person_id) values ($1, 'Old Group', $2) returning id",
      [orgId, personId]
    );
    return rows[0]!.id;
  }

  async function createPost(
    q: Queryable,
    groupId: string,
    options: { parentPostId?: string | null; createdAt: string; kind?: "MESSAGE" | "EVENT" }
  ): Promise<string> {
    const { rows } = await q.query<{ id: string }>(
      `insert into group_posts (group_id, author_person_id, parent_post_id, kind, body, created_at)
       values ($1, $2, $3, $4, $5, $6::timestamptz)
       returning id`,
      [
        groupId,
        personId,
        options.parentPostId ?? null,
        options.kind ?? "MESSAGE",
        options.kind === "EVENT" ? null : "hello",
        options.createdAt,
      ]
    );
    return rows[0]!.id;
  }

  const SIX_YEARS_AGO = "2019-01-01T00:00:00Z";
  const ONE_YEAR_AGO = "2024-01-01T00:00:00Z";
  const NOW = new Date("2025-01-01T00:00:00Z");

  it("deletes a six-year-old thread with no replies", async () => {
    const groupId = await createGroup(db());
    const rootId = await createPost(db(), groupId, { createdAt: SIX_YEARS_AGO });

    const result = await expireGroupPosts(db(), { now: NOW });
    expect(result.byOrganization.get(orgId)?.posts).toBe(1);

    const { rows } = await db().query("select id from group_posts where id = $1", [rootId]);
    expect(rows).toHaveLength(0);
  });

  it("keeps a six-year-old root alive if it has a recent reply", async () => {
    const groupId = await createGroup(db());
    const rootId = await createPost(db(), groupId, { createdAt: SIX_YEARS_AGO });
    await createPost(db(), groupId, { createdAt: ONE_YEAR_AGO, parentPostId: rootId });

    const result = await expireGroupPosts(db(), { now: NOW });
    expect(result.byOrganization.has(orgId)).toBe(false);

    const { rows } = await db().query("select id from group_posts where id = $1", [rootId]);
    expect(rows).toHaveLength(1);
  });

  it("keeps a far-future event alive even if it was posted six years ago", async () => {
    const groupId = await createGroup(db());
    const eventPostId = await createPost(db(), groupId, {
      createdAt: SIX_YEARS_AGO,
      kind: "EVENT",
    });
    await db().query(
      "insert into group_events (post_id, title, event_date) values ($1, 'Far future', '2099-01-01')",
      [eventPostId]
    );

    const result = await expireGroupPosts(db(), { now: NOW });
    expect(result.byOrganization.has(orgId)).toBe(false);

    const { rows } = await db().query("select id from group_posts where id = $1", [eventPostId]);
    expect(rows).toHaveLength(1);
  });

  it("writes one audit row per organization with the counts", async () => {
    const groupId = await createGroup(db());
    await createPost(db(), groupId, { createdAt: SIX_YEARS_AGO });
    await createPost(db(), groupId, { createdAt: SIX_YEARS_AGO });

    await expireGroupPosts(db(), { now: NOW });

    const { rows } = await db().query<{ action: string; changes: { posts: number } }>(
      "select action, changes from audit_log where action = 'group.post.expire' and organization_id = $1",
      [orgId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changes.posts).toBe(2);
  });

  it("does nothing when nothing has aged out", async () => {
    const groupId = await createGroup(db());
    await createPost(db(), groupId, { createdAt: ONE_YEAR_AGO });

    const result = await expireGroupPosts(db(), { now: NOW });
    expect(result.byOrganization.size).toBe(0);
  });

  it("takes a purged post's reactions with it, without moving the group's activity stamp", async () => {
    const groupId = await createGroup(db());
    const postId = await createPost(db(), groupId, { createdAt: SIX_YEARS_AGO });
    const { rows: users } = await db().query<{ app_user_id: string }>(
      "select app_user_id from persons where id = $1",
      [personId]
    );
    await db().query(
      "insert into group_post_reactions (post_id, app_user_id, emoji) values ($1, $2, '🔥')",
      [postId, users[0]!.app_user_id]
    );
    const stamp = async () =>
      (await db().query("select activity_at from groups where id = $1", [groupId])).rows[0]!
        .activity_at as Date;
    const before = await stamp();

    await expireGroupPosts(db(), { now: NOW });

    const { rows } = await db().query("select 1 from group_post_reactions");
    expect(rows).toHaveLength(0);
    expect((await stamp()).getTime()).toBe(before.getTime());
  });
});

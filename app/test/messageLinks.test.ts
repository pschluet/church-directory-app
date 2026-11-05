import { describe, expect, it } from "vitest";
import { messagePath } from "../src/lib/messageLinks";

describe("messagePath", () => {
  it("links a message of its own to the feed", () => {
    expect(messagePath("g1", { id: "p1", parentPostId: null })).toBe("/groups/g1?message=p1");
  });

  it("links a reply to its thread", () => {
    expect(messagePath("g1", { id: "r1", parentPostId: "p1" }, "MESSAGE")).toBe(
      "/groups/g1/threads/p1?message=r1"
    );
    // Not knowing what it hangs off is a thread too; the thread page sends an
    // event's reply on to the event.
    expect(messagePath("g1", { id: "r1", parentPostId: "p1" })).toBe(
      "/groups/g1/threads/p1?message=r1"
    );
  });

  it("links a reply to an event to the event's page", () => {
    expect(messagePath("g1", { id: "r1", parentPostId: "e1" }, "EVENT")).toBe(
      "/groups/g1/events/e1?message=r1"
    );
  });
});

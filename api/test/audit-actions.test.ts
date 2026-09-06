import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, auditActionLabel } from "../src/types";

/**
 * Keeps `AUDIT_ACTIONS` honest by reading the code that writes them.
 *
 * `audit_log.action` is plain text with no CHECK constraint -- deliberately, see
 * V13__audit_log_browse.sql -- and every value is an inline string literal at
 * one of nearly thirty call sites. So the shared list has nothing enforcing it
 * and no compiler help, which is exactly the shape of thing that drifts.
 *
 * The audit log page is built so that drift is only cosmetic: an unknown action
 * still lists, still filters, and shows its raw string instead of a label. This
 * test is what turns cosmetic into caught, and it needs no database.
 */
const ROUTE_FILES = [
  "persons.ts",
  "families.ts",
  "merges.ts",
  "admin.ts",
  "organizations.ts",
  "prayer-requests.ts",
  "special-dates.ts",
  "me.ts",
];

/**
 * The two `action:` occurrences that are not a value at all: `auditMerge`'s
 * parameter type, and the property that forwards its argument on. The literals
 * they stand for are picked up from the `auditMerge` call sites instead.
 *
 * Anything else that yields no literal is a form this test cannot read, which
 * is a failure rather than something to skip -- an action it cannot see is an
 * action it cannot check.
 */
const NOT_A_LITERAL = new Set(["action", "string"]);

interface Scan {
  actions: Set<string>;
  entityTypes: Set<string>;
  unreadable: string[];
}

function scanRoutes(): Scan {
  const actions = new Set<string>();
  const entityTypes = new Set<string>();
  const unreadable: string[] = [];

  for (const file of ROUTE_FILES) {
    const source = readFileSync(join(__dirname, "..", "src", "routes", file), "utf8");

    // The property value only, stopping at the comma -- taking the whole line
    // would swallow the `entityType` sitting beside it on the one-liners.
    for (const match of source.matchAll(/\baction:\s*([^,;}\n]+)/g)) {
      const segment = match[1]!;
      const literals = [...segment.matchAll(/"([^"]+)"/g)].map((found) => found[1]!);
      if (literals.length === 0) {
        if (!NOT_A_LITERAL.has(segment.trim()))
          unreadable.push(`${file}: action: ${segment.trim()}`);
        continue;
      }
      for (const literal of literals) actions.add(literal);
    }

    for (const match of source.matchAll(/\bentityType:\s*([^,;}\n]+)/g)) {
      for (const found of match[1]!.matchAll(/"([^"]+)"/g)) entityTypes.add(found[1]!);
    }

    // The one wrapper that takes the action as an argument.
    for (const match of source.matchAll(/auditMerge\(([^)]*)\)/g)) {
      for (const found of match[1]!.matchAll(/"([^"]+)"/g)) actions.add(found[1]!);
    }
  }

  return { actions, entityTypes, unreadable };
}

describe("audit action and entity type lists", () => {
  const scan = scanRoutes();

  it("finds actions to check in the first place", () => {
    // A regex that silently matched nothing would make every assertion below
    // pass while checking nothing at all.
    expect(scan.actions.size).toBeGreaterThan(20);
    expect(scan.entityTypes.size).toBeGreaterThan(3);
  });

  it("can read every action the routes write", () => {
    expect(scan.unreadable).toEqual([]);
  });

  it("has a label for every action the routes write", () => {
    const missing = [...scan.actions].filter(
      (action) => !(AUDIT_ACTIONS as readonly string[]).includes(action)
    );
    expect(
      missing,
      `Add these to AUDIT_ACTIONS and AUDIT_ACTION_LABELS in api/src/types.ts: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("has a label for every entity type the routes write", () => {
    const missing = [...scan.entityTypes].filter(
      (entityType) => !(AUDIT_ENTITY_TYPES as readonly string[]).includes(entityType)
    );
    expect(missing).toEqual([]);
  });

  /*
   * The other direction, so the list does not silently accumulate labels for
   * actions that were renamed or removed.
   */
  it("lists no action that nothing writes any more", () => {
    const stale = AUDIT_ACTIONS.filter((action) => !scan.actions.has(action));
    expect(stale).toEqual([]);
  });

  it("labels every known action, and falls back to the raw string", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(auditActionLabel(action)).not.toBe(action);
    }
    expect(auditActionLabel("family.archive")).toBe("family.archive");
  });
});

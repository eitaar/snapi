import { describe, expect, it } from "vitest";
import { ContactResolver, type ContactRecord } from "../../src/messaging/contact-resolver.js";

const contacts: readonly ContactRecord[] = [
  { userId: "id-1", conversationId: "c-1", username: "alice", displayName: "Alex" },
  { userId: "id-2", conversationId: "c-2", username: "bob", displayName: "Alex" },
  { userId: "id-3", conversationId: "c-3", username: "carol", displayName: "Carol C" },
];

describe("ContactResolver", () => {
  it("resolves exact IDs and case-insensitive exact usernames", () => {
    expect(ContactResolver.resolve("id-1", contacts)).toBe(contacts[0]);
    expect(ContactResolver.resolve("CAROL", contacts)).toBe(contacts[2]);
  });

  it("resolves a unique exact display name", () => {
    expect(ContactResolver.resolve("carol c", contacts)).toBe(contacts[2]);
  });

  it("rejects fuzzy and missing matches", () => {
    expect(() => ContactResolver.resolve("ali", contacts)).toThrow("not found");
    expect(() => ContactResolver.resolve("nobody", contacts)).toThrow("not found");
  });

  it("returns only safe candidate identity fields for an ambiguous display name", () => {
    try {
      ContactResolver.resolve("alex", contacts);
      throw new Error("expected ambiguity");
    } catch (error) {
      expect(error).toMatchObject({
        code: "RECIPIENT_NOT_FOUND",
        details: { candidates: [
          { userId: "id-1", username: "alice", displayName: "Alex" },
          { userId: "id-2", username: "bob", displayName: "Alex" },
        ] },
      });
    }
  });
});

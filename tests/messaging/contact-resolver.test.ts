import { describe, expect, it } from "vitest";
import { ContactResolver, type ContactRecord } from "../../src/messaging/contact-resolver.js";

const contacts: readonly ContactRecord[] = [
  { userId: "id-1", conversationId: "conversation-1", username: "alice", displayName: "Shared" },
  { userId: "id-2", conversationId: "conversation-2", username: "bob", displayName: "Shared" },
  { userId: "id-3", conversationId: "conversation-3", username: "Carol", displayName: "Carol C" },
];

describe("ContactResolver", () => {
  it("resolves exact ids and exact case-insensitive names", () => {
    expect(ContactResolver.resolve("id-1", contacts).userId).toBe("id-1");
    expect(ContactResolver.resolve("BOB", contacts).userId).toBe("id-2");
    expect(ContactResolver.resolve("carol c", contacts).userId).toBe("id-3");
  });

  it("never fuzzy matches and reports missing recipients", () => {
    expect(() => ContactResolver.resolve("car", contacts)).toThrowError(
      expect.objectContaining({ code: "RECIPIENT_NOT_FOUND" }),
    );
  });

  it("rejects ambiguous display names without selecting a candidate", () => {
    expect(() => ContactResolver.resolve("shared", contacts)).toThrowError(
      expect.objectContaining({
        code: "RECIPIENT_NOT_FOUND",
        details: { candidates: [
          { userId: "id-1", username: "alice", displayName: "Shared" },
          { userId: "id-2", username: "bob", displayName: "Shared" },
        ] },
      }),
    );
  });
});

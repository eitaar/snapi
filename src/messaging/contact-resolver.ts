import { AppError } from "../errors.js";

export interface ContactRecord {
  readonly userId: string;
  readonly conversationId: string;
  readonly username: string;
  readonly displayName?: string;
}

export type ResolvedContact = ContactRecord;

export class ContactResolver {
  static resolve(query: string, contacts: readonly ContactRecord[]): ResolvedContact {
    const exactId = contacts.filter(({ userId }) => userId === query);
    if (exactId.length === 1) return exactId[0]!;

    const normalized = query.toLocaleLowerCase("en-US");
    const matches = contacts.filter(({ username, displayName }) =>
      username.toLocaleLowerCase("en-US") === normalized ||
      displayName?.toLocaleLowerCase("en-US") === normalized,
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new AppError("RECIPIENT_NOT_FOUND", "Exact recipient match was not found");
    }
    throw new AppError("RECIPIENT_NOT_FOUND", "Recipient query is ambiguous", {
      candidates: matches.map(({ userId, username, displayName }) => ({
        userId,
        username,
        ...(displayName === undefined ? {} : { displayName }),
      })),
    });
  }
}

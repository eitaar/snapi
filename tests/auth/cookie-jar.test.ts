import { describe, expect, it } from "vitest";
import { CookieJar } from "../../src/auth/cookie-jar.js";

describe("CookieJar", () => {
  it("keeps cookies scoped to their response origin and path", () => {
    const jar = new CookieJar({ now: () => 1_700_000_000_000 });
    jar.mergeHeader("https://accounts.snapchat.com/accounts/sso", "sso=old");
    jar.setFromResponse("https://web.snapchat.com/", ["web=old; Path=/"]);
    jar.setFromResponse("https://web.snapchat.com/web-chat-session/refresh", ["wide=old; Path=/web-chat-session"]);
    jar.setFromResponse("https://web.snapchat.com/private/resource", ["narrow=old; Path=/private"]);

    expect(jar.headerFor("https://accounts.snapchat.com/accounts/sso")).toBe("sso=old");
    expect(jar.headerFor("https://web.snapchat.com/web-chat-session/refresh")).toBe("wide=old; web=old");
    expect(jar.headerFor("https://web.snapchat.com/private")).toBe("narrow=old; web=old");
  });

  it("applies Set-Cookie attributes, rotation, and deletion", () => {
    const jar = new CookieJar({ now: () => 1_700_000_000_000 });
    jar.mergeHeader("https://accounts.snapchat.com/accounts/sso", "session=old; theme=dark");
    jar.mergeHeader("https://web.snapchat.com/", "session=web");

    jar.mergeHeader(
      "https://accounts.snapchat.com/accounts/sso",
      "session=old; theme=dark",
    );
    jar.setFromResponse("https://accounts.snapchat.com/accounts/sso", [
      "session=new; Path=/; Secure; HttpOnly",
      "theme=; Max-Age=0; Path=/",
      "shared=value; Domain=.snapchat.com; Path=/",
    ]);

    expect(jar.headerFor("https://accounts.snapchat.com/accounts/sso")).toBe(
      "session=new; shared=value",
    );
    expect(jar.headerFor("https://web.snapchat.com/anything")).toBe("session=web; shared=value");
  });

  it("does not send Secure cookies over http or expired cookies after time advances", () => {
    let now = 1_700_000_000_000;
    const jar = new CookieJar({ now: () => now });
    jar.setFromResponse("https://web.snapchat.com/", [
      "secure=yes; Secure; Path=/",
      "short=lived; Max-Age=10; Path=/",
    ]);

    expect(jar.headerFor("http://web.snapchat.com/")).toBe("short=lived");
    now += 11_000;
    expect(jar.headerFor("https://web.snapchat.com/")).toBe("secure=yes");
  });

  it("rejects a Set-Cookie domain outside the response host", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://web.snapchat.com/", ["leak=blocked; Domain=evil.example; Path=/"]);

    expect(jar.headerFor("https://web.snapchat.com/")).toBe("");
    expect(jar.headerFor("https://evil.example/")).toBe("");
  });
});

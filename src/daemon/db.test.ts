import { describe, expect, test } from "bun:test";
import { Store } from "./db.ts";

function makeStore(): { store: Store; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  const store = Store.openInMemory({ now: () => clock.now });
  return { store, clock };
}

describe("sessions", () => {
  test("createSession assigns a url-safe unique id and active status", () => {
    const { store } = makeStore();
    const a = store.createSession();
    const b = store.createSession();
    expect(a.id).toMatch(/^[a-z0-9]{8}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.status).toBe("active");
    expect(a.name).toBeNull();
  });

  test("upsertNamedSession creates once and reuses by name", () => {
    const { store } = makeStore();
    const first = store.upsertNamedSession("my-review");
    const second = store.upsertNamedSession("my-review");
    expect(second.id).toBe(first.id);
    expect(store.listSessions(false)).toHaveLength(1);
  });

  test("upsertNamedSession reactivates an archived session", () => {
    const { store } = makeStore();
    const session = store.upsertNamedSession("my-review");
    store.archiveSession(session.id);
    expect(store.getSession(session.id)?.status).toBe("archived");
    const revived = store.upsertNamedSession("my-review");
    expect(revived.id).toBe(session.id);
    expect(revived.status).toBe("active");
  });

  test("listSessions(false) hides archived, listSessions(true) includes them", () => {
    const { store } = makeStore();
    const active = store.createSession();
    const archived = store.createSession();
    store.archiveSession(archived.id);
    expect(store.listSessions(false).map((s) => s.id)).toEqual([active.id]);
    expect(
      store
        .listSessions(true)
        .map((s) => s.id)
        .toSorted(),
    ).toEqual([active.id, archived.id].toSorted());
  });

  test("archiveAllActive archives every active session (crash recovery)", () => {
    const { store } = makeStore();
    store.createSession();
    store.createSession();
    store.archiveAllActive();
    expect(store.countActiveSessions()).toBe(0);
  });
});

describe("publish and revisions", () => {
  test("first publish creates file with revision 1 and isNew=true", () => {
    const { store } = makeStore();
    const session = store.createSession();
    const result = store.publish(session.id, "report.md", "markdown", "# はじめてのレポート");
    expect(result.isNew).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.file.name).toBe("report.md");
    expect(result.file.format).toBe("markdown");
  });

  test("same name publish overwrites: revision increments, file count stays 1", () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.publish(session.id, "report.md", "markdown", "v1");
    const second = store.publish(session.id, "report.md", "markdown", "v2 更新版");
    expect(second.isNew).toBe(false);
    expect(second.revision).toBe(2);
    expect(store.listFiles(session.id)).toHaveLength(1);
    expect(store.getRevisionContent(second.file.id, 1)).toBe("v1");
    expect(store.getRevisionContent(second.file.id, 2)).toBe("v2 更新版");
  });

  test("same file name in different sessions are independent", () => {
    const { store } = makeStore();
    const a = store.createSession();
    const b = store.createSession();
    store.publish(a.id, "report.md", "markdown", "in A");
    const inB = store.publish(b.id, "report.md", "markdown", "in B");
    expect(inB.isNew).toBe(true);
    expect(inB.revision).toBe(1);
  });

  test("title: undefined keeps existing, provided value replaces", () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.publish(session.id, "report.md", "markdown", "v1", "最初のタイトル");
    const kept = store.publish(session.id, "report.md", "markdown", "v2");
    expect(kept.file.title).toBe("最初のタイトル");
    const replaced = store.publish(session.id, "report.md", "markdown", "v3", "新タイトル");
    expect(replaced.file.title).toBe("新タイトル");
  });

  test("listFiles returns latestRev per file", () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.publish(session.id, "a.md", "markdown", "1");
    store.publish(session.id, "a.md", "markdown", "2");
    store.publish(session.id, "b.html", "html", "<p>hi</p>");
    const files = store.listFiles(session.id);
    const byName = new Map(files.map((f) => [f.name, f]));
    expect(byName.get("a.md")?.latestRev).toBe(2);
    expect(byName.get("b.html")?.latestRev).toBe(1);
  });

  test("empty content is a valid revision", () => {
    const { store } = makeStore();
    const session = store.createSession();
    const result = store.publish(session.id, "empty.md", "markdown", "");
    expect(store.getRevisionContent(result.file.id, 1)).toBe("");
  });

  test("getRevisionContent returns null for missing revision", () => {
    const { store } = makeStore();
    const session = store.createSession();
    const result = store.publish(session.id, "a.md", "markdown", "x");
    expect(store.getRevisionContent(result.file.id, 99)).toBeNull();
  });

  test("publishing an existing name with a different format throws", () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.publish(session.id, "report.md", "markdown", "v1");
    expect(() => store.publish(session.id, "report.md", "html", "<p>v2</p>")).toThrow(
      /format mismatch/,
    );
    expect(store.getFile(session.id, "report.md")?.latestRev).toBe(1);
  });

  test("publish to unknown session throws", () => {
    const { store } = makeStore();
    expect(() => store.publish("nosuchid", "a.md", "markdown", "x")).toThrow();
  });

  test("listRevisions returns metadata in rev order", () => {
    const { store, clock } = makeStore();
    const session = store.createSession();
    const first = store.publish(session.id, "a.md", "markdown", "1");
    clock.now = 2_000_000;
    store.publish(session.id, "a.md", "markdown", "2");
    const revisions = store.listRevisions(first.file.id);
    expect(revisions.map((r) => r.rev)).toEqual([1, 2]);
    expect(revisions[1]?.createdAt).toBe(2_000_000);
  });
});

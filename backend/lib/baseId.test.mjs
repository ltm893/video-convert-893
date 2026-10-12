import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const {
  resolveId,
  resolveRegion,
  resolveCalendarTable,
  resolveCreateTable,
} = createRequire(import.meta.url)("./baseId.cjs");

test("id comes from the base config when the add-on omits it", () => {
  assert.equal(resolveId(undefined, "acme"), "acme");
  assert.equal(resolveId("", "acme"), "acme");
  assert.equal(resolveId("your-id-here", "acme"), "acme");
});

test("an add-on id that already names a stack is kept", () => {
  assert.equal(resolveId("calendar893", "apps-893"), "calendar893");
});

test("a missing base id fails", () => {
  assert.throws(() => resolveId(undefined, undefined), /Set id/);
  assert.throws(() => resolveId(undefined, "your-id-here"), /Set id/);
});

test("region comes from the base config when the add-on omits it", () => {
  assert.equal(resolveRegion(undefined, "us-east-1"), "us-east-1");
  assert.equal(resolveRegion("us-west-2", "us-east-1"), "us-west-2");
});

test("calendar table defaults to {id}-calendar and createTable defaults to true", () => {
  assert.equal(resolveCalendarTable("acme", undefined), "acme-calendar");
  assert.equal(resolveCalendarTable("acme", "your-id-here-calendar"), "acme-calendar");
  assert.equal(resolveCalendarTable("calendar893", "CalendarEvents"), "CalendarEvents");
  assert.equal(resolveCreateTable(undefined), true);
  assert.equal(resolveCreateTable(false), false);
  assert.equal(resolveCreateTable(true), true);
});

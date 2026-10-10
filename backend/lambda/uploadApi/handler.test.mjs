import { test } from "node:test";
import assert from "node:assert/strict";
import { handler } from "./handler.mjs";

const userId = "11111111-2222-3333-4444-555555555555";

function event(overrides = {}) {
  return {
    httpMethod: "GET",
    path: "/jobs",
    requestContext: { authorizer: { claims: { sub: userId } } },
    ...overrides,
  };
}

test("missing or short Cognito sub is 401", async () => {
  const missing = await handler({ httpMethod: "GET", path: "/jobs" });
  assert.equal(missing.statusCode, 401);
  assert.equal(JSON.parse(missing.body).error, "Unauthorized");

  const short = await handler(event({
    requestContext: { authorizer: { claims: { sub: "abc" } } },
  }));
  assert.equal(short.statusCode, 401);
  assert.equal(JSON.parse(short.body).error, "Unauthorized");
});

test("body that is not JSON is 400", async () => {
  const response = await handler(event({
    httpMethod: "POST",
    path: "/uploads",
    body: "{",
  }));
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "invalid JSON");
});

test("unknown path is 404", async () => {
  const response = await handler(event({ path: "/nope" }));
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error, "Not found");
});

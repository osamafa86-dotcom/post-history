import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePath, contractOperations, controllerRoutes, unparsedControllers, webCalls,
  iosGeneratedOperations, consumerCalls, routeKey, formatReport, run,
} from "./contract-clients.mjs";

const CONTRACT = `openapi: 3.1.0
paths:
  /orders:
    get:
      operationId: listOrders
      responses: {}
    post:
      operationId: createOrder
      responses: {}
  /orders/{order_id}/checkout:
    post:
      operationId: checkoutOrder
      responses: {}
  '/health':
    head:
      responses: {}
  /materials/{id}:
    parameters:
      - name: id
        in: path
    get:
      operationId: getMaterial
      description: "وصف: بنقطتين"
      responses: {}
components: {}
`;

test("contract operations carry method, normalized path and operationId", () => {
  const operations = contractOperations(CONTRACT);
  assert.deepEqual(operations.map(routeKey), [
    "GET /orders", "POST /orders", "POST /orders/{}/checkout", "HEAD /health", "GET /materials/{}",
  ]);
  assert.deepEqual(operations.map((op) => op.operationId), [
    "listOrders", "createOrder", "checkoutOrder", null, "getMaterial",
  ]);
});

test("web calls read openapi-fetch literals from api.METHOD and upstream(...).METHOD", () => {
  const calls = webCalls(`
const a = requireOk(await api.GET("/orders/{order_id}", { params }));
const b = requireOk(await api.POST("/orders", { body }));
const c = await upstream(config, undefined, transport).POST("/auth/refresh", { body });
const d = api.GET(path, {});
`, "web/server/x.ts");
  assert.deepEqual(calls.map(routeKey), ["GET /orders/{}", "POST /orders", "POST /auth/refresh"]);
  assert.deepEqual(calls.map((call) => call.line), [2, 3, 4]);
});

test("ios generated surface pairs each literal path with its builder method in order", () => {
  const { operations, warnings } = iosGeneratedOperations(`
open class func loginWithRequestBuilder() -> RequestBuilder<Session> {
    var localVariablePath = "/auth/login"
    let localVariableRequestBuilder: RequestBuilder<Session>.Type = apiConfiguration.requestBuilderFactory.getBuilder()
    return localVariableRequestBuilder.init(method: "POST", URLString: url, parameters: p, headers: h, requiresAuthentication: false, apiConfiguration: apiConfiguration)
}
open class func getMeWithRequestBuilder() -> RequestBuilder<Me> {
    let localVariablePath = "/auth/me"
    let idPreEscape = "\\(APIHelper.mapValueToPathItem(id))"
    localVariablePath = localVariablePath.replacingOccurrences(of: "{id}", with: idPreEscape)
    return localVariableRequestBuilder.init(method: "GET", URLString: url, parameters: p, headers: h, requiresAuthentication: true, apiConfiguration: apiConfiguration)
}
`, "ios/APIs/AuthAPI.swift");
  assert.deepEqual(operations.map(routeKey), ["POST /auth/login", "GET /auth/me"]);
  assert.deepEqual(warnings, []);
});

test("ios generated surface warns when path and method counts disagree", () => {
  const { operations, warnings } = iosGeneratedOperations(`
var localVariablePath = "/auth/login"
var localVariablePath = "/auth/logout"
return builder.init(method: "POST", URLString: url)
`, "ios/APIs/AuthAPI.swift");
  assert.equal(operations.length, 1);
  assert.deepEqual(warnings, [{ file: "ios/APIs/AuthAPI.swift", paths: 2, methods: 1 }]);
});

test("consumer calls match operationIds on API receivers and ignore lookalikes", () => {
  const ids = new Map([["login", {}], ["getMe", {}], ["logout", {}]]);
  const ios = consumerCalls(`
try await AuthAPI.login(loginRequest: request)
let builder = AuthAPI.logoutWithRequestBuilder(logoutRequest: nil)
let legacy = await AdminAPI.deprecatedCall(x)
let session = await AuthSession.login(elsewhere)
`, "ios/AuthCore/AuthGateway.swift", "ios", ids);
  assert.deepEqual(ios.calls.map((call) => [call.operationId, call.line]), [["login", 2], ["logout", 3]]);
  assert.deepEqual(ios.unknown.map((call) => call.name), ["deprecatedCall"]);
  const android = consumerCalls(`
val me = container.authApi.getMe()
val session = publicAuthApi.login(LoginRequest())
auth.login(email, password)
`, "android/HomeScreen.kt", "android", ids);
  assert.deepEqual(android.calls.map((call) => [call.operationId, call.line]), [["getMe", 2], ["login", 3]]);
  assert.deepEqual(android.unknown, []);
});

function fixtureTree() {
  const dir = mkdtempSync(join(tmpdir(), "contract-clients-test-"));
  const openapi = join(dir, "openapi.yaml");
  writeFileSync(openapi, CONTRACT);
  const api = join(dir, "api");
  mkdirSync(api);
  writeFileSync(join(api, "orders.controller.ts"), `@Controller('orders')
class Orders {
  @Get() list() {}
  @Post() create() {}
  @Post(':orderId/checkout') checkout() {}
}
`);
  writeFileSync(join(api, "health.controller.ts"), `@Controller('health')
class Health { @Head() tick() {} }
`);
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "orders.ts"), `const a = requireOk(await api.GET("/orders", {}));
const b = requireOk(await api.POST("/orders", {}));
const c = requireOk(await api.POST("/orders/{order_id}/checkout", {}));
const d = requireOk(await api.GET("/phantom", {}));
`);
  const iosApis = join(dir, "ios", "Packages", "PostHistoryKit", "Sources", "PostHistoryAPI", "APIs");
  mkdirSync(iosApis, { recursive: true });
  writeFileSync(join(iosApis, "OrdersAPI.swift"), `open class func listOrdersWithRequestBuilder() -> RequestBuilder<Page> {
    var localVariablePath = "/orders"
    return localVariableRequestBuilder.init(method: "GET", URLString: url, parameters: p, headers: h, requiresAuthentication: true, apiConfiguration: c)
}
`);
  const iosCore = join(dir, "ios", "Packages", "PostHistoryKit", "Sources", "OrdersCore");
  mkdirSync(iosCore, { recursive: true });
  writeFileSync(join(iosCore, "OrdersFeed.swift"), `let page = try await OrdersAPI.listOrders(cursor: nil)
`);
  const iosTests = join(dir, "ios", "Packages", "PostHistoryKit", "Tests", "OrdersCoreTests");
  mkdirSync(iosTests, { recursive: true });
  writeFileSync(join(iosTests, "Fakes.swift"), `let fake = try await OrdersAPI.createOrder(createOrderRequest: r)
`);
  const android = join(dir, "android", "app", "src", "main", "kotlin", "net", "palpost");
  mkdirSync(android, { recursive: true });
  writeFileSync(join(android, "HomeScreen.kt"), `val page = container.ordersApi.listOrders(cursor = null)
val one = container.ordersApi.getMaterial(id = id)
`);
  return { dir, openapi, api, web, ios: join(dir, "ios"), android: join(dir, "android") };
}

test("inspect merges contract, server and the three clients per operation", async () => {
  const { dir, openapi, api, web, ios, android } = fixtureTree();
  try {
    const { code, result } = await run(["--json", openapi, api, web, ios, android], { ...process.env, GITHUB_ACTIONS: "" });
    assert.equal(code, 0);
    const by = new Map(result.operations.map((op) => [op.key, op]));
    const list = by.get("GET /orders");
    assert.deepEqual([list.inContract, list.inServer, list.iosGenerated], [true, true, true]);
    assert.equal(list.consumers.web.length, 1);
    assert.equal(list.consumers.ios.length, 1);
    assert.equal(list.consumers.android.length, 1);
    const material = by.get("GET /materials/{}");
    assert.equal(material.inContract, true);
    assert.equal(material.inServer, false);
    assert.equal(material.consumers.android.length, 1);
    const phantom = by.get("GET /phantom");
    assert.equal(phantom.inContract, false);
    assert.equal(phantom.consumers.web.length, 1);
    assert.deepEqual(result.contractOnly.map(routeKey).sort(), ["GET /materials/{}", "HEAD /health"]);
    assert.deepEqual(result.webOnly.map(routeKey), ["GET /phantom"]);
    assert.equal(result.iosGeneratedOnly.length, 0);
    // نداءات مجلد Tests لا تُحسب استهلاكًا.
    assert.equal(result.iosConsumers.some((call) => call.file.includes("Tests")), false);
    assert.match(formatReport(result), /GET \/phantom — العقد: لا \| الخادم: لا \| web: 1 \| ios: 0 \| android: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict mode returns one on drift and missing directories degrade to warnings", async () => {
  const { dir, openapi, api, web, ios, android } = fixtureTree();
  try {
    const strict = await run(["--strict", openapi, api, web, ios, android], { ...process.env, GITHUB_ACTIONS: "" });
    assert.equal(strict.code, 1);
    const missing = await run([openapi, join(dir, "none-api"), join(dir, "none-web"), join(dir, "none-ios"), join(dir, "none-android")], { ...process.env, GITHUB_ACTIONS: "" });
    assert.equal(missing.code, 0);
    assert.equal(missing.result.missingDirs.length, 4);
    assert.match(formatReport(missing.result), /MISSING_DIR web/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller and decorator helpers stay aligned with contract-drift", () => {
  const routes = controllerRoutes("@Controller('materials')\nclass M { @Get(':id/files/:fileId/download-url') one() {} }\n");
  assert.deepEqual(routes.map(routeKey), ["GET /materials/{}/files/{}/download-url"]);
  assert.equal(unparsedControllers("@Controller(computePrefix())\nclass C {}\n").length, 1);
  assert.equal(normalizePath("/orders/{order_id}/"), "/orders/{}");
});

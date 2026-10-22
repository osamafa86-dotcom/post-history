import XCTest
import PostHistoryAPI
@testable import UploadCore

/// الجلسة خلف بوابة ingest (SEC-07): كل طلب tus يحمل `Ingest-Token`، و`401` من البوابة يعني رمزًا جديدًا ثم HEAD.
final class IngestGateEngineTests: XCTestCase {
    typealias Harness = UploadEngineTests.Harness

    func testEveryTusRequestCarriesTheIngestTokenWhenTheSessionRequiresIt() async throws {
        let tokens = FakeIngestTokens()
        let h = Harness(name: "ingest-happy", ingest: tokens)
        h.api.ingestTokenRequired = true
        h.transport.validIngestToken = "ingest-1"
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.serverBytes, h.bytes)
        XCTAssertFalse(h.transport.ingestTokensSeen.isEmpty)
        XCTAssertTrue(h.transport.ingestTokensSeen.allSatisfy { $0 == "ingest-1" }, "create and every PATCH carry the token")
        XCTAssertEqual(tokens.issued, 1, "the provider's cached token is reused across requests")
        XCTAssertEqual(tokens.forgotten, [h.api.sessionId], "the token is forgotten once the receipt arrives")
    }

    func testNoIngestTokenWhenTheServerDoesNotRequireIt() async throws {
        let tokens = FakeIngestTokens()
        let h = Harness(name: "ingest-off", ingest: tokens)
        let rec = try await h.enqueue()
        _ = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertTrue(h.transport.ingestTokensSeen.allSatisfy { $0 == nil })
        XCTAssertEqual(tokens.issued, 0)
    }

    func testExpiredIngestTokenOnPatchIsRefreshedThenResumesFromHead() async throws {
        // الرمز الأول يُقبل للإنشاء وأول جزء، ثم «ينتهي»: البوابة ترفض الجزء التالي بـ 401 قبل أن يصل إلى tusd.
        let tokens = FakeIngestTokens()
        let h = Harness(name: "ingest-expiry", ingest: tokens)
        h.api.ingestTokenRequired = true
        h.transport.validIngestToken = "ingest-1"
        h.transport.rotateIngestTokenAfterPatches = (1, "ingest-2")
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.serverBytes, h.bytes, "no byte lost or duplicated across the token change")
        XCTAssertGreaterThanOrEqual(tokens.forced, 1)
        XCTAssertGreaterThanOrEqual(h.transport.headCalls, 1, "resumes from the server offset after the refresh")
    }

    func testIngestTokenRejectedOnCreateIsRefreshedWithoutTriggeringTheSingleCreateRule() async throws {
        let tokens = FakeIngestTokens()
        tokens.cached[UUID()] = "unused"
        let h = Harness(name: "ingest-create", ingest: tokens)
        h.api.ingestTokenRequired = true
        h.transport.validIngestToken = "ingest-2" // الرمز الأول يُرفض عند البوابة
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.creates.count, 1, "the rejected create never reached tusd")
        XCTAssertEqual(tokens.forced, 1)
    }

    func testGateThatKeepsRejectingFreshTokensFailsAsExpiredAfterTheRefreshBudget() async throws {
        let tokens = FakeIngestTokens()
        let h = Harness(name: "ingest-loop", ingest: tokens)
        h.api.ingestTokenRequired = true
        h.transport.validIngestToken = "never-issued"
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .failed(.expired))
        XCTAssertEqual(tokens.forced, UploadEngine.maxIngestRefreshes)
        XCTAssertTrue(h.transport.creates.isEmpty)
    }

    func testDeviceWithoutAppAttestFailsWithDeviceNotAttested() async throws {
        let tokens = FakeIngestTokens()
        tokens.error = .unsupported
        let h = Harness(name: "ingest-unsupported", ingest: tokens)
        h.api.ingestTokenRequired = true
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .failed(.deviceNotAttested))
        XCTAssertTrue(h.transport.creates.isEmpty)
    }

    func testNoProviderButSessionRequiresTheGateFailsWithDeviceNotAttested() async throws {
        let h = Harness(name: "ingest-noprovider")
        h.api.ingestTokenRequired = true
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .failed(.deviceNotAttested))
    }

    func testTemporaryAttestationOutageIsRetriedThenSucceeds() async throws {
        let tokens = FakeIngestTokens()
        tokens.error = .temporarilyUnavailable
        let h = Harness(name: "ingest-outage", ingest: tokens)
        h.api.ingestTokenRequired = true
        h.transport.validIngestToken = "ingest-1"
        let rec = try await h.enqueue()
        _ = await h.engine.waitUntil(rec.id) { $0.attempt >= 1 }
        tokens.lock.withLock { tokens.error = nil }
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
    }

    func testOlderPersistedRecordsWithoutTheFlagStillDecode() throws {
        let json = #"{"uploadSessionId":"5D6C7B8A-9F0E-4D1C-8B2A-3C4D5E6F7A8B","tusEndpoint":"https://x.invalid/files/","tusMetadata":{},"partSizeBytes":1048576,"checksumAlgorithm":"sha256","expiresAt":0,"uploadTokenExpiresAt":0}"#
        let remote = try JSONDecoder().decode(RemoteSession.self, from: Data(json.utf8))
        XCTAssertNil(remote.ingestTokenRequired)
    }
}

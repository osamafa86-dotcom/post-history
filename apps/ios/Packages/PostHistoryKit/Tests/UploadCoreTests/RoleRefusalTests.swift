import XCTest
import PostHistoryAPI
@testable import UploadCore

/// بناء TestFlight 13: حساب بلا دور مراسل أرسل فيديو فرأى «تعذّر إثبات الجهاز» عند 0%، والخادم ردّ `403 forbidden_role` لا
/// `attestation_failed`. الرفض بالدور يُعرف من رمزه أينما جاء (إنشاء الجلسة، التحدي، رمز البوابة)، ويُقال بكلماته.
final class RoleRefusalTests: XCTestCase {
    typealias Harness = UploadEngineTests.Harness

    private func body(_ code: String) -> Data { Data(#"{"code":"\#(code)","message":"m","request_id":"r"}"#.utf8) }
    private struct E: Error {}

    func testUploadSessionErrorsMapByCodeNotByStatusAlone() {
        XCTAssertEqual(UploadAPIError.map(ErrorResponse.error(403, body("forbidden_role"), nil, E())), .forbidden)
        XCTAssertEqual(UploadAPIError.map(ErrorResponse.error(403, body("forbidden_scope"), nil, E())), .forbidden)
        // ما عداهما يبقى كما كان: جلسة أو رمز لا يخوّل.
        XCTAssertEqual(UploadAPIError.map(ErrorResponse.error(403, body("credential_reset_required"), nil, E())), .unauthorized)
        XCTAssertEqual(UploadAPIError.map(ErrorResponse.error(403, nil, nil, E())), .unauthorized)
        XCTAssertEqual(UploadAPIError.map(ErrorResponse.error(401, body("unauthorized"), nil, E())), .unauthorized)
        XCTAssertFalse(UploadAPIError.forbidden.isRetryable)
        XCTAssertNil(ServerErrorCode.of(Data("not json".utf8)))
        XCTAssertEqual(ServerErrorCode.of(body("forbidden_role")), "forbidden_role")
    }

    func testARoleRefusalOnSessionCreationFailsAsNotPermittedWithoutRetrying() async throws {
        let h = Harness(name: "role-create")
        h.api.createError = .forbidden
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .failed(.notPermitted))
        XCTAssertEqual(h.api.createBodies.count, 1, "a role answer is final")
        XCTAssertTrue(h.transport.creates.isEmpty)
    }

    func testARoleRefusalFromTheIngestGateFailsAsNotPermittedNotDeviceNotAttested() async throws {
        let tokens = FakeIngestTokens()
        tokens.error = .notPermitted
        let h = Harness(name: "role-ingest", ingest: tokens)
        h.api.ingestTokenRequired = true
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .failed(.notPermitted))
        XCTAssertNotEqual(done?.phase, .failed(.deviceNotAttested))
        XCTAssertTrue(h.transport.creates.isEmpty)
    }

    /// والعكس: رفض الشهادة يبقى «تعذّر إثبات الجهاز».
    func testAnAttestationRejectionStaysDeviceNotAttested() async throws {
        let tokens = FakeIngestTokens()
        tokens.error = .attestationRejected
        let h = Harness(name: "role-attest", ingest: tokens)
        h.api.ingestTokenRequired = true
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .failed(.deviceNotAttested))
    }

    func testTheNewFailureDecodesFromItsStoredName() throws {
        let decoded = try JSONDecoder().decode([UploadFailure].self, from: Data(#"["not_permitted","device_not_attested"]"#.utf8))
        XCTAssertEqual(decoded, [.notPermitted, .deviceNotAttested])
        XCTAssertTrue(UploadFailure.allCases.contains(.deviceNotAttested))
    }
}

import XCTest
import PostHistoryAPI
@testable import UploadCore

/// النسخة الخفيفة أولًا (ADR 0075): لا تُنشأ جلسة أصل ما دامت نسخة خفيفة في الطابور لم تنتهِ، أو نسخة مادته قيد التحضير.
final class ProxyFirstEngineTests: XCTestCase {
    typealias Harness = UploadEngineTests.Harness

    private func kinds(_ h: Harness) -> [UploadSessionCreate.Kind] { h.api.createBodies.map(\.kind) }

    private func settle() async { try? await Task.sleep(nanoseconds: 150_000_000) }

    func testOriginalWaitsWhileAnyProxyIsUnfinishedThenProceeds() async throws {
        let h = Harness(name: "proxy-first", script: [.hang])
        await h.engine.resumeAll()
        let proxy = try await h.engine.enqueue(sourcePath: h.source.path, materialId: UUID(), kind: .proxy, filename: "p.mp4", mimeType: "video/mp4", proxyMode: .urgent)
        _ = await h.engine.waitUntil(proxy.id) { $0.phase == .transferring }
        let original = try await h.engine.enqueue(sourcePath: h.source.path, materialId: UUID(), kind: .original, filename: "clip.mov", mimeType: "video/quicktime")
        await settle()
        XCTAssertEqual(kinds(h), [.proxy], "no original session while a light copy is still uploading")
        let parked = await h.engine.record(original.id)
        XCTAssertEqual(parked?.phase, .creatingSession)
        let waiting = await h.engine.waitingForProxy()
        XCTAssertEqual(waiting, [original.id])

        await h.engine.cancel(proxy.id)
        _ = await h.engine.waitUntil(original.id) { $0.phase != .creatingSession }
        XCTAssertEqual(kinds(h), [.proxy, .original], "the original starts once no light copy is pending")
        let none = await h.engine.waitingForProxy()
        XCTAssertTrue(none.isEmpty)
    }

    func testOriginalAwaitingItsProxyWaitsUntilTheHoldIsReleased() async throws {
        let h = Harness(name: "proxy-hold")
        await h.engine.resumeAll()
        let material = UUID()
        let original = try await h.engine.enqueue(sourcePath: h.source.path, materialId: material, kind: .original, filename: "clip.mov", mimeType: "video/quicktime", awaitsProxy: true)
        await settle()
        XCTAssertTrue(h.api.createBodies.isEmpty, "the light copy is still being prepared")
        let held = await h.engine.record(original.id)
        XCTAssertNotNil(held?.sha256Hex, "hashing the original does not wait")

        await h.engine.releaseProxyHold(materialId: material) // التحضير فشل أو اختار المراسل الأصل فقط
        let done = await h.engine.waitUntil(original.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
    }

    func testEnqueuingTheProxyReleasesTheHoldAndGoesFirst() async throws {
        let h = Harness(name: "proxy-arrives", script: [.hang])
        await h.engine.resumeAll()
        let material = UUID()
        let original = try await h.engine.enqueue(sourcePath: h.source.path, materialId: material, kind: .original, filename: "clip.mov", mimeType: "video/quicktime", awaitsProxy: true)
        let proxy = try await h.engine.enqueue(sourcePath: h.source.path, materialId: material, kind: .proxy, filename: "p.mp4", mimeType: "video/mp4", proxyMode: .normal)
        _ = await h.engine.waitUntil(proxy.id) { $0.phase == .transferring }
        await settle()
        let parked = await h.engine.record(original.id)
        XCTAssertEqual(parked?.phase, .creatingSession)
        XCTAssertEqual(kinds(h), [.proxy], "the hold moved from the preparation to the uploading light copy")
        XCTAssertEqual(h.api.createBodies.first?.proxyMode, .normal)
    }

    func testHoldOrphanedByAppTerminationIsReleasedOnLaunch() async throws {
        // التطبيق أُنهي أثناء تحضير النسخة: الأصل محفوظ بانتظارها ولا نسخة في الطابور.
        let store = InMemoryUploadStateStore()
        let first = Harness(name: "proxy-orphan", store: store)
        await first.engine.resumeAll()
        let original = try await first.engine.enqueue(sourcePath: first.source.path, materialId: UUID(), kind: .original, filename: "clip.mov", mimeType: "video/quicktime", awaitsProxy: true)
        _ = await first.engine.waitUntil(original.id) { $0.sha256Hex != nil }

        let relaunched = Harness(name: "proxy-orphan", store: store, secrets: first.sharedSecrets, dir: first.dir)
        await relaunched.engine.resumeAll()
        let done = await relaunched.engine.waitUntil(original.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"), "uploads without a light copy rather than waiting forever")
    }

    /// نسخة عالقة (الخادم لا ينهيها، أو تنتظر شبكة) لا تؤخر الأصول بلا حد: بعد نافذة الأولوية يُرفع الأصل.
    func testStuckProxyDoesNotStarveOriginalsBeyondThePriorityWindow() async throws {
        var timing = Fixtures.fastTiming
        timing.proxyPriorityWindow = 0.4
        let h = Harness(name: "proxy-stuck", script: [.hang], timing: timing)
        await h.engine.resumeAll()
        let proxy = try await h.engine.enqueue(sourcePath: h.source.path, materialId: UUID(), kind: .proxy, filename: "p.mov", mimeType: "video/quicktime", proxyMode: .urgent)
        _ = await h.engine.waitUntil(proxy.id) { $0.phase == .transferring }
        let original = try await h.engine.enqueue(sourcePath: h.source.path, materialId: UUID(), kind: .original, filename: "clip.mov", mimeType: "video/quicktime")
        await settle()
        XCTAssertEqual(kinds(h), [.proxy], "still inside the window")
        _ = await h.engine.waitUntil(original.id) { $0.phase != .creatingSession }
        XCTAssertEqual(kinds(h), [.proxy, .original], "the window elapsed while the light copy is still stuck")
        let stillPending = await h.engine.record(proxy.id)
        XCTAssertFalse(stillPending?.phase.isTerminal ?? true)
    }

    /// تحضير لا ينتهي ولا يُرفع انتظاره (معطّل AVFoundation مثلًا) يخضع للنافذة نفسها.
    func testPreparationThatNeverEndsIsBoundedByTheSameWindow() async throws {
        var timing = Fixtures.fastTiming
        timing.proxyPriorityWindow = 0.4
        let h = Harness(name: "proxy-hold-stuck", timing: timing)
        await h.engine.resumeAll()
        let original = try await h.engine.enqueue(sourcePath: h.source.path, materialId: UUID(), kind: .original, filename: "clip.mov", mimeType: "video/quicktime", awaitsProxy: true)
        await settle()
        XCTAssertTrue(h.api.createBodies.isEmpty)
        let done = await h.engine.waitUntil(original.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
    }

    func testRecordsSavedBeforeTheFieldStillDecode() throws {
        let rec = UploadRecord(materialId: UUID(), kind: .original, sourcePath: "Uploads/a.mov", filename: "a.mov", mimeType: nil, sizeBytes: 1)
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(rec)) as! [String: Any]
        json.removeValue(forKey: "awaitsProxy")
        let decoded = try JSONDecoder().decode(UploadRecord.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(decoded.awaitsProxy)
    }
}

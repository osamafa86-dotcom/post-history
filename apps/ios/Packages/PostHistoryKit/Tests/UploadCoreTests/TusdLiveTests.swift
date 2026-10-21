import XCTest
@testable import UploadCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// تكامل حي مع tusd (يُشغَّل في CI: `TUSD_URL=http://127.0.0.1:8080/files/`). يتخطى إن غاب المتغير.
final class TusdLiveTests: XCTestCase {
    final class Collector: TusTransportDelegate, @unchecked Sendable {
        let lock = NSLock()
        var outcomes: [(TusTaskKey, TusPatchOutcome)] = []
        func patchDidFinish(_ key: TusTaskKey, _ outcome: TusPatchOutcome) async { lock.withLock { outcomes.append((key, outcome)) } }
        func wait(count: Int, timeout: TimeInterval = 10) async -> [(TusTaskKey, TusPatchOutcome)] {
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline, lock.withLock({ outcomes.count }) < count { try? await Task.sleep(nanoseconds: 20_000_000) }
            return lock.withLock { outcomes }
        }
    }

    func testCreatePatchResumeAfterOffsetMismatch() async throws {
        guard let base = ProcessInfo.processInfo.environment["TUSD_URL"].flatMap(URL.init) else { throw XCTSkip("TUSD_URL not set") }
        let dir = Fixtures.tempDir("live")
        let (source, bytes) = Fixtures.sourceFile(in: dir, bytes: 10_000)
        let slicer = ChunkSlicer(chunksDirectory: dir.appendingPathComponent("chunks"))
        let transport = URLSessionTusTransport(configuration: .ephemeral)
        let collector = Collector()
        await transport.setDelegate(collector)
        let id = UUID()

        let uploadURL = try await transport.createUpload(TusCreateRequest(endpoint: base, token: "t", length: 10_000, metadata: ["upload_session_id": id.uuidString, "filename": "clip.mov"]))
        let initial = try await transport.currentOffset(uploadURL: uploadURL, token: "t", ingestToken: nil)
        XCTAssertEqual(initial, 0)

        let c1 = try slicer.prepare(uploadId: id, source: source, offset: 0, length: 4096)
        try await transport.schedulePatch(TusPatchRequest(key: TusTaskKey(uploadId: id, offset: 0), uploadURL: uploadURL, token: "t", chunk: c1, chunkFile: slicer.url(of: c1)))
        var outcomes = await collector.wait(count: 1)
        XCTAssertEqual(outcomes.last?.1, .completed(newOffset: 4096))

        // جزء بموضع قديم (كأن حدثًا قديمًا أعاد إرساله): الخادم يرد 409 ثم نستأنف من HEAD
        try await transport.schedulePatch(TusPatchRequest(key: TusTaskKey(uploadId: id, offset: 1), uploadURL: uploadURL, token: "t", chunk: c1, chunkFile: slicer.url(of: c1)))
        outcomes = await collector.wait(count: 2)
        XCTAssertEqual(outcomes.last?.1, .failed(.offsetMismatch))
        let offset = try await transport.currentOffset(uploadURL: uploadURL, token: "t", ingestToken: nil)
        XCTAssertEqual(offset, 4096)


        let c2 = try slicer.prepare(uploadId: id, source: source, offset: offset, length: 10_000 - offset)
        try await transport.schedulePatch(TusPatchRequest(key: TusTaskKey(uploadId: id, offset: offset), uploadURL: uploadURL, token: "t", chunk: c2, chunkFile: slicer.url(of: c2)))
        outcomes = await collector.wait(count: 3)
        XCTAssertEqual(outcomes.last?.1, .completed(newOffset: 10_000))
        let final = try await transport.currentOffset(uploadURL: uploadURL, token: "t", ingestToken: nil)
        XCTAssertEqual(final, 10_000)
        let active = await transport.activePatchKeys()
        XCTAssertTrue(active.isEmpty)
        XCTAssertEqual(bytes.count, 10_000)
    }
}

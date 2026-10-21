import Foundation
import UploadCore

/// يغلّف نقل tus الحقيقي ويسجّل ما يحتاجه netlab.py: زمن كل PATCH ونتيجته، نجاح/فشل كل طلب (نوافذ الاتصال)،
/// HEAD بعد الفشل (استئناف)، والبايتات المؤكدة التي عاد HEAD بإزاحة قبلها (يجب أن تبقى صفرًا).
/// التعريفات مطابقة لـ `Session` في tools/netlab/netlab.py كي تُحسب المقاييس هناك.
final class RecordingTransport: TusTransport, TusTransportDelegate, @unchecked Sendable {
    struct Part: Encodable { var seconds: Double; var bytes: Int64; var ok: Bool }

    private let inner: any TusTransport
    private let lock = NSLock()
    private weak var engineDelegate: TusTransportDelegate?
    private var inFlight: [TusTaskKey: (start: Date, length: Int64)] = [:]

    private(set) var parts: [Part] = []
    private(set) var windows: [Double] = []
    private var connectedSince: Date?
    private(set) var resumes = 0
    private(set) var failures = 0
    private(set) var confirmed: Int64 = 0
    private(set) var bytesLost: Int64 = 0
    private(set) var uploadURL: URL?
    private(set) var headOffsets: [Int64] = []

    init(inner: any TusTransport) { self.inner = inner }

    // MARK: Session bookkeeping (netlab.py semantics)

    private func ok(at t: Date) { lock.withLock { if connectedSince == nil { connectedSince = t } } }
    private func fail() {
        lock.withLock {
            failures += 1
            if let since = connectedSince { windows.append(Date().timeIntervalSince(since)); connectedSince = nil }
        }
    }
    func close() { lock.withLock { if let since = connectedSince { windows.append(Date().timeIntervalSince(since)); connectedSince = nil } } }

    // MARK: TusTransport

    func setDelegate(_ delegate: TusTransportDelegate?) async {
        lock.withLock { engineDelegate = delegate }
        await inner.setDelegate(self)
    }

    func createUpload(_ request: TusCreateRequest) async throws -> URL {
        let t = Date()
        do {
            let url = try await inner.createUpload(request)
            lock.withLock { uploadURL = url }
            ok(at: t)
            return url
        } catch { fail(); throw error }
    }

    func currentOffset(uploadURL: URL, token: String, ingestToken: String?) async throws -> Int64 {
        let t = Date()
        do {
            let offset = try await inner.currentOffset(uploadURL: uploadURL, token: token, ingestToken: ingestToken)
            lock.withLock {
                resumes += 1
                headOffsets.append(offset)
                bytesLost += max(0, confirmed - offset)
            }
            ok(at: t)
            return offset
        } catch { fail(); throw error }
    }

    func schedulePatch(_ request: TusPatchRequest) async throws {
        lock.withLock { inFlight[request.key] = (Date(), request.chunk.length) }
        try await inner.schedulePatch(request)
    }

    func activePatchKeys() async -> Set<TusTaskKey> { await inner.activePatchKeys() }
    func cancel(uploadId: UUID) async { await inner.cancel(uploadId: uploadId) }

    // MARK: TusTransportDelegate (from the inner transport)

    func patchDidFinish(_ key: TusTaskKey, _ outcome: TusPatchOutcome) async {
        let started = lock.withLock { inFlight.removeValue(forKey: key) }
        let seconds = started.map { Date().timeIntervalSince($0.start) } ?? 0
        switch outcome {
        case .completed(let newOffset):
            lock.withLock {
                parts.append(Part(seconds: seconds, bytes: started?.length ?? 0, ok: true))
                confirmed = max(confirmed, newOffset)
            }
            ok(at: started?.start ?? Date())
        case .failed:
            lock.withLock { parts.append(Part(seconds: seconds, bytes: 0, ok: false)) }
            fail()
        }
        let target = lock.withLock { engineDelegate }
        await target?.patchDidFinish(key, outcome)
    }

    /// الملخص الذي يقرأه netlab.py (`--client-cmd`).
    struct Summary: Encodable {
        var url_path: String?
        var offset: Int64
        var complete: Bool
        var parts: [[Double]]
        var windows: [Double]
        var resumes: Int
        var failures: Int
        var bytes_lost: Int64
        var head_offsets: [Int64]
    }

    func summary(complete: Bool, finalOffset: Int64) -> Summary {
        close()
        return lock.withLock {
            Summary(url_path: uploadURL?.path, offset: finalOffset, complete: complete,
                    parts: parts.map { [($0.seconds * 1000).rounded() / 1000, Double($0.bytes), $0.ok ? 1 : 0] },
                    windows: windows.map { ($0 * 10).rounded() / 10 }, resumes: resumes, failures: failures,
                    bytes_lost: bytesLost, head_offsets: headOffsets)
        }
    }
}

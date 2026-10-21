import Foundation
import PostHistoryAPI

/// نواة الرفع: تدفع كل سجل عبر مراحله، وتستأنف من آخر موضع أكّده الخادم بعد الانقطاع وإنهاء التطبيق وإعادة تشغيل الجهاز.
/// كل الحالة في `UploadStateStore`؛ الرموز في `UploadSecretStore`؛ النقل عبر `TusTransport` (جلسة خلفية على الجهاز).
public actor UploadEngine: TusTransportDelegate {
    public struct Timing: Sendable {
        public var retryDelays: [TimeInterval] = [1, 2, 5, 10, 30, 60, 120]
        public var receiptPollInterval: TimeInterval = 3
        public var sleep: @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
        public init() {}
    }

    public struct Environment: Sendable {
        /// مجلد المستندات الذي تُحل عليه المسارات النسبية للملفات الأصلية.
        public var documentsDirectory: URL?
        /// هل التطبيق في الخلفية الآن (يحدد حجم الجزء عند بدء الجلسة).
        public var isBackground: @Sendable () -> Bool = { false }
        /// تقدير الصعود بالبايت/ث من قياس الشبكة عند البدء، إن وُجد.
        public var uplinkBytesPerSecond: @Sendable () -> Double? = { nil }
        public var hasher: @Sendable (URL) throws -> String = { try SHA256Stream.hex(of: $0) }
        public var now: @Sendable () -> Date = { Date() }
        public init() {}
    }

    private let store: any UploadStateStore
    private let secrets: any UploadSecretStore
    private let api: any UploadAPI
    private let transport: any TusTransport
    private let ingest: (any IngestTokenProvider)?
    private let slicer: ChunkSlicer
    private let policy: ChunkSizePolicy
    private let timing: Timing
    private let env: Environment

    private var records: [UUID: UploadRecord] = [:]
    private var busy: Set<UUID> = []
    /// سجلات تنتظر HEAD؛ لا يُجدوَل لها جزء حتى يُطبَّق موضع الخادم.
    private var resyncing: Set<UUID> = []
    private var subscribers: [UUID: AsyncStream<UploadEvent>.Continuation] = [:]
    private var retryTasks: [UUID: Task<Void, Never>] = [:]
    /// تجديدات رمز ingest المتتالية بعد `401` من البوابة لكل سجل؛ تُصفَّر مع أول جزء ناجح.
    private var ingestRefreshes: [UUID: Int] = [:]
    /// حد التجديدات المتتالية: رمز جديد ما زال يُرفض = مشكلة لا يحلها التجديد.
    static let maxIngestRefreshes = 3

    public init(store: any UploadStateStore, secrets: any UploadSecretStore, api: any UploadAPI, transport: any TusTransport,
                ingestTokens: (any IngestTokenProvider)? = nil,
                slicer: ChunkSlicer, policy: ChunkSizePolicy = ChunkSizePolicy(), timing: Timing = Timing(), environment: Environment = Environment()) {
        self.store = store
        self.secrets = secrets
        self.api = api
        self.transport = transport
        self.ingest = ingestTokens
        self.slicer = slicer
        self.policy = policy
        self.timing = timing
        self.env = environment
    }

    // MARK: واجهة عامة

    public func events() -> AsyncStream<UploadEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<UploadEvent>.makeStream()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.removeSubscriber(id) } }
        return stream
    }

    private func removeSubscriber(_ id: UUID) { subscribers[id] = nil }

    public func allRecords() -> [UploadRecord] { records.values.sorted { $0.createdAt < $1.createdAt } }
    public func record(_ id: UUID) -> UploadRecord? { records[id] }

    /// يضيف ملفًا إلى الطابور ويبدأ دفعه. `sourcePath` نسبي إلى مجلد المستندات أو مطلق.
    @discardableResult
    public func enqueue(sourcePath: String, materialId: UUID, kind: UploadSessionCreate.Kind, filename: String, mimeType: String?, proxyMode: UploadSessionCreate.ProxyMode? = nil) async throws -> UploadRecord {
        let url = resolve(sourcePath)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let record = UploadRecord(materialId: materialId, kind: kind, proxyMode: proxyMode, sourcePath: sourcePath, filename: filename, mimeType: mimeType, sizeBytes: size, now: env.now())
        records[record.id] = record
        try store.save(record)
        Task { await self.step(record.id) }
        return record
    }

    /// عند الإطلاق: يحمّل السجلات ويستأنف غير المكتمل. مهمة PATCH ما زالت في النظام لا تُعاد بل يُنتظر حدثها.
    public func resumeAll() async {
        await transport.setDelegate(self)
        for r in (try? store.loadAll()) ?? [] { records[r.id] = r }
        let active = await transport.activePatchKeys()
        for var rec in records.values where !rec.phase.isTerminal {
            let id = rec.id
            if rec.phase == .transferring, let off = rec.inFlightOffset, active.contains(TusTaskKey(uploadId: rec.id, offset: off)) { continue }
            if rec.phase == .transferring {
                rec.inFlightOffset = nil
                records[id] = rec
                await resync(id)
            } else {
                Task { await self.step(id) }
            }
        }
    }

    public func cancel(_ id: UUID) async {
        guard var rec = records[id], !rec.phase.isTerminal else { return }
        retryTasks[id]?.cancel()
        await transport.cancel(uploadId: id)
        rec.inFlightOffset = nil
        rec.prepared = []
        slicer.discardAll(uploadId: id)
        try? secrets.removeToken(for: id)
        await forgetIngest(rec)
        setPhase(&rec, .cancelled)
    }

    /// المسح الطارئ أو إبطال الجلسة: يلغي كل مهام النقل الخلفية ويحذف كل السجلات وملفات الأجزاء ورموز الرفع. لا يُسجَّل شيء.
    /// لا يلمس الملفات الأصلية؛ حذفها على طبقة التطبيق (`LocalDataWiper`).
    public func wipeAll() async -> Int {
        let ids = Array(records.keys)
        for id in ids {
            retryTasks[id]?.cancel()
            retryTasks[id] = nil
            await transport.cancel(uploadId: id)
            if let rec = records[id] { await forgetIngest(rec) }
            slicer.discardAll(uploadId: id)
            try? secrets.removeToken(for: id)
            try? store.remove(id: id)
        }
        records.removeAll()
        busy.removeAll()
        resyncing.removeAll()
        ingestRefreshes.removeAll()
        return ids.count
    }

    /// يحذف سجلًا منتهيًا وآثاره (لا يحذف الملف الأصلي؛ حذفه قرار المراسل في الواجهة).
    public func remove(_ id: UUID) throws {
        guard let rec = records[id], rec.phase.isTerminal else { return }
        slicer.discardAll(uploadId: id)
        try? secrets.removeToken(for: id)
        try store.remove(id: id)
        records[id] = nil
    }

    // MARK: TusTransportDelegate

    public nonisolated func patchDidFinish(_ key: TusTaskKey, _ outcome: TusPatchOutcome) async {
        await handlePatch(key, outcome)
    }

    private func handlePatch(_ key: TusTaskKey, _ outcome: TusPatchOutcome) async {
        guard var rec = records[key.uploadId], rec.phase == .transferring, rec.inFlightOffset == key.offset else { return } // حدث قديم
        rec.inFlightOffset = nil
        switch outcome {
        case .completed(let newOffset):
            rec.attempt = 0
            rec.lastErrorCode = nil
            ingestRefreshes[rec.id] = nil
            applyServerOffset(&rec, newOffset)
            save(rec)
            emit(.progress(id: rec.id, confirmedOffset: rec.confirmedOffset, sizeBytes: rec.sizeBytes))
            await step(rec.id)
        case .failed(let error):
            rec.lastErrorCode = String(describing: error)
            if error == .authenticationRequired, consumeIngestRefresh(rec) {
                save(rec)
                await resync(rec.id, refreshIngest: true)
                return
            }
            guard error.isRetryable else {
                let reason: UploadFailure = Self.isAuthFailure(error) ? .expired : error == .gone ? .aborted : .rejected
                rec.prepared.forEach(slicer.discard)
                rec.prepared = []
                setPhase(&rec, .failed(reason))
                return
            }
            save(rec)
            await resync(rec.id)
        }
    }

    // MARK: الدفع

    private func step(_ id: UUID) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        while var rec = records[id], !rec.phase.isTerminal {
            do {
                switch rec.phase {
                case .hashing:
                    let source = try sourceURL(rec)
                    let hasher = env.hasher
                    rec.sha256Hex = try await Task.detached(priority: .utility) { try hasher(source) }.value
                    setPhase(&rec, .creatingSession)
                case .creatingSession:
                    let body = UploadSessionCreate(materialId: rec.materialId, kind: rec.kind, sizeBytes: Int(rec.sizeBytes), filename: rec.filename, mimeType: rec.mimeType, proxyMode: rec.proxyMode, clientSha256: rec.sha256Hex)
                    let created = try await api.createSession(idempotencyKey: rec.createIdempotencyKey, body)
                    guard let endpoint = URL(string: created.tusEndpoint) else { throw UploadError.invalidEndpoint }
                    try secrets.setToken(created.uploadToken, for: rec.id)
                    var metadata = created.tusMetadata.additionalProperties
                    metadata["upload_session_id"] = created.tusMetadata.uploadSessionId.uuidString.lowercased()
                    rec.remote = RemoteSession(uploadSessionId: created.id, tusEndpoint: endpoint, tusMetadata: metadata, partSizeBytes: Int64(created.partSizeBytes),
                                               checksumAlgorithm: (created.checksumAlgorithm ?? .sha256).rawValue, expiresAt: created.expiresAt, uploadTokenExpiresAt: created.uploadTokenExpiresAt,
                                               ingestTokenRequired: created.ingestTokenRequired)
                    rec.chunkSizeBytes = policy.chunkSize(background: env.isBackground(), measuredUplinkBytesPerSecond: env.uplinkBytesPerSecond())
                    setPhase(&rec, .creatingUpload)
                case .creatingUpload:
                    guard let remote = rec.remote else { setPhase(&rec, .creatingSession); continue }
                    let uploadToken = try token(rec.id)
                    let ingestToken = try await ingestToken(rec, forceRefresh: false)
                    do {
                        rec.tusUploadURL = try await transport.createUpload(TusCreateRequest(endpoint: remote.tusEndpoint, token: uploadToken, length: rec.sizeBytes, metadata: remote.tusMetadata, ingestToken: ingestToken))
                        rec.confirmedOffset = 0
                    } catch TusError.authenticationRequired where consumeIngestRefresh(rec) {
                        // رمز البوابة رُفض قبل وصول الطلب إلى tusd: لا إنشاء حدث؛ رمز جديد ثم إعادة الخطوة نفسها.
                        _ = try await self.ingestToken(rec, forceRefresh: true)
                        continue
                    } catch TusError.unauthorized {
                        // ضاع رد الإنشاء (انقطاع أو قتل التطبيق بعد الإرسال): الخادم حجز الجلسة في pre-create ويرفض إنشاءً ثانيًا بالرمز نفسه.
                        // الرابط حتمي (نقطة tus + معرّف الجلسة، لأن ChangeFileInfo.ID = معرّف الجلسة)، فيُسأل عنه HEAD ويُستأنف منه.
                        let deterministic = Self.deterministicUploadURL(endpoint: remote.tusEndpoint, sessionId: remote.uploadSessionId)
                        rec.confirmedOffset = try await transport.currentOffset(uploadURL: deterministic, token: uploadToken, ingestToken: ingestToken)
                        rec.tusUploadURL = deterministic
                    }
                    setPhase(&rec, .transferring)
                case .transferring:
                    if rec.confirmedOffset >= rec.sizeBytes { setPhase(&rec, .completing); continue }
                    if rec.inFlightOffset != nil || resyncing.contains(id) { return } // بانتظار حدث النقل أو موضع الخادم
                    try prepareWindow(&rec)
                    guard let chunk = rec.prepared.first, let uploadURL = rec.tusUploadURL else { throw UploadError.sourceTruncated }
                    let ingestToken = try await ingestToken(rec, forceRefresh: false)
                    let request = TusPatchRequest(key: TusTaskKey(uploadId: rec.id, offset: chunk.offset), uploadURL: uploadURL, token: try token(rec.id), chunk: chunk, chunkFile: slicer.url(of: chunk), ingestToken: ingestToken)
                    rec.inFlightOffset = chunk.offset
                    save(rec)
                    try await transport.schedulePatch(request)
                    // قد تصل نتيجة الجزء أثناء الجدولة (والمستدعي من الحدث يجد السجل مشغولًا)؛ تُعاد قراءة الحالة بدل الخروج.
                    continue
                case .completing:
                    guard let remote = rec.remote else { throw UploadAPIError.notFound }
                    do { try await api.complete(idempotencyKey: rec.completeIdempotencyKey, id: remote.uploadSessionId, reportedSha256: rec.sha256Hex) }
                    catch UploadAPIError.conflict {} // مسار tusd: الاكتمال يصل من الخطّاف؛ نكتفي بانتظار التحقق
                    setPhase(&rec, .awaitingReceipt)
                case .awaitingReceipt:
                    guard let remote = rec.remote else { throw UploadAPIError.notFound }
                    let session = try await api.session(id: remote.uploadSessionId)
                    switch session.state {
                    case .verified:
                        try? secrets.removeToken(for: rec.id)
                        await forgetIngest(rec)
                        setPhase(&rec, .verified(receiptNumber: session.receiptNumber ?? ""))
                    case .deduplicated:
                        try? secrets.removeToken(for: rec.id)
                        await forgetIngest(rec)
                        setPhase(&rec, .deduplicated(duplicateOfFileId: session.duplicateOfFileId))
                    case .failed:
                        setPhase(&rec, .failed(Self.failure(session.failureReason)))
                    default:
                        try await timing.sleep(timing.receiptPollInterval)
                    }
                default:
                    return
                }
            } catch {
                await fail(or: error, id: id)
                return
            }
        }
    }

    /// يصنّف الخطأ: نهائي ← `failed`؛ قابل للإعادة ← محاولة بعد مهلة متزايدة.
    private func fail(or error: any Error, id: UUID) async {
        guard var rec = records[id] else { return }
        rec.lastErrorCode = String(describing: error)
        switch error {
        case UploadError.sourceTruncated, is CocoaError:
            setPhase(&rec, .failed(.sourceMissing))
        case IngestTokenError.unsupported, IngestTokenError.attestationRejected:
            setPhase(&rec, .failed(.deviceNotAttested))
        case TusError.authenticationRequired where consumeIngestRefresh(rec):
            // HEAD رُفض عند البوابة: رمز جديد ثم HEAD من جديد بعد مهلة قصيرة.
            save(rec)
            await forgetIngest(rec)
            scheduleRetry(id)
        case UploadAPIError.unauthorized:
            setPhase(&rec, .failed(.expired))
        case let e as UploadAPIError where !e.isRetryable:
            setPhase(&rec, .failed(.rejected))
        case let e as TusError where !e.isRetryable:
            setPhase(&rec, .failed(Self.isAuthFailure(e) ? .expired : e == .gone ? .aborted : .rejected))
        case UploadError.invalidEndpoint, UploadStoreError.missingToken:
            setPhase(&rec, .failed(.rejected))
        default:
            save(rec)
            scheduleRetry(id)
        }
    }

    private func scheduleRetry(_ id: UUID) {
        guard var rec = records[id] else { return }
        rec.attempt += 1
        let delay = timing.retryDelays[min(rec.attempt, timing.retryDelays.count) - 1]
        save(rec)
        emit(.retryScheduled(id: id, attempt: rec.attempt, after: delay))
        retryTasks[id]?.cancel()
        retryTasks[id] = Task { [timing] in
            guard (try? await timing.sleep(delay)) != nil else { return }
            await self.step(id)
        }
    }

    /// يسأل الخادم عن موضعه (HEAD) ويُعيد مواءمة الأجزاء المُجهَّزة، ثم يستأنف.
    private func resync(_ id: UUID, refreshIngest: Bool = false) async {
        guard let rec = records[id], rec.phase == .transferring, rec.inFlightOffset == nil, let url = rec.tusUploadURL, !resyncing.contains(id) else { return }
        resyncing.insert(id)
        let head: Result<Int64, any Error>
        do {
            let ingestToken = try await ingestToken(rec, forceRefresh: refreshIngest)
            head = .success(try await transport.currentOffset(uploadURL: url, token: try token(id), ingestToken: ingestToken))
        } catch { head = .failure(error) }
        resyncing.remove(id)
        guard var rec = records[id], rec.phase == .transferring else { return }
        switch head {
        case .success(let serverOffset):
            applyServerOffset(&rec, serverOffset)
            save(rec)
            emit(.progress(id: id, confirmedOffset: rec.confirmedOffset, sizeBytes: rec.sizeBytes))
            if rec.attempt == 0 { await step(id) } else { scheduleRetry(id) }
        case .failure(let error):
            await fail(or: error, id: id)
        }
    }

    private func applyServerOffset(_ rec: inout UploadRecord, _ serverOffset: Int64) {
        rec.confirmedOffset = serverOffset
        let (keep, drop) = ChunkPlanner.reconcile(prepared: rec.prepared, serverOffset: serverOffset)
        drop.forEach(slicer.discard)
        rec.prepared = keep
    }

    /// يجهّز الأجزاء حتى امتلاء النافذة، ويعيد تجهيز ما فُقد ملفه (مثلًا بعد إعادة تشغيل الجهاز).
    private func prepareWindow(_ rec: inout UploadRecord) throws {
        let source = try sourceURL(rec)
        if let i = rec.prepared.firstIndex(where: { !slicer.exists($0) }) { rec.prepared.removeSubrange(i...) }
        for (offset, length) in ChunkPlanner.chunksToPrepare(sizeBytes: rec.sizeBytes, confirmedOffset: rec.confirmedOffset, chunkSize: rec.chunkSizeBytes, prepared: rec.prepared, window: policy.preparedWindow) {
            rec.prepared.append(try slicer.prepare(uploadId: rec.id, source: source, offset: offset, length: length))
        }
    }

    // MARK: مساعدات

    private func resolve(_ path: String) -> URL {
        path.hasPrefix("/") ? URL(fileURLWithPath: path) : (env.documentsDirectory ?? URL(fileURLWithPath: NSTemporaryDirectory())).appendingPathComponent(path)
    }

    private func sourceURL(_ rec: UploadRecord) throws -> URL {
        let url = resolve(rec.sourcePath)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard (attrs[.size] as? NSNumber)?.int64Value == rec.sizeBytes else { throw UploadError.sourceTruncated }
        return url
    }

    /// رمز البوابة حين تطلبه الجلسة، وإلا `nil`. جلسة تطلبه بلا مصدر = جهاز لا يستطيع الرفع خلف البوابة.
    private func ingestToken(_ rec: UploadRecord, forceRefresh: Bool) async throws -> String? {
        guard let remote = rec.remote, remote.ingestTokenRequired == true else { return nil }
        guard let ingest else { throw IngestTokenError.unsupported }
        return try await ingest.ingestToken(uploadSessionId: remote.uploadSessionId, forceRefresh: forceRefresh)
    }

    private func forgetIngest(_ rec: UploadRecord) async {
        guard let remote = rec.remote, remote.ingestTokenRequired == true else { return }
        await ingest?.forget(uploadSessionId: remote.uploadSessionId)
    }

    /// يستهلك تجديدًا واحدًا لرمز البوابة بعد `401` إن كانت الجلسة خلف البوابة ولم يُستنفد الحد.
    private func consumeIngestRefresh(_ rec: UploadRecord) -> Bool {
        guard rec.remote?.ingestTokenRequired == true, ingest != nil else { return false }
        let used = ingestRefreshes[rec.id, default: 0]
        guard used < Self.maxIngestRefreshes else { return false }
        ingestRefreshes[rec.id] = used + 1
        return true
    }

    static func isAuthFailure(_ e: TusError) -> Bool { e == .unauthorized || e == .authenticationRequired }

    private func token(_ id: UUID) throws -> String {
        guard let t = try secrets.token(for: id) else { throw UploadStoreError.missingToken }
        return t
    }

    private func setPhase(_ rec: inout UploadRecord, _ phase: UploadPhase) {
        rec.phase = phase
        if phase.isTerminal { rec.inFlightOffset = nil }
        save(rec)
        emit(.phaseChanged(id: rec.id, phase: phase))
    }

    private func save(_ rec: UploadRecord) {
        var r = rec
        r.updatedAt = env.now()
        records[r.id] = r
        try? store.save(r)
    }

    private func emit(_ event: UploadEvent) { subscribers.values.forEach { $0.yield(event) } }

    /// رابط رفع tus الذي يثبّته الخادم في `pre-create`: `<tus_endpoint><upload_session_id>`.
    public static func deterministicUploadURL(endpoint: URL, sessionId: UUID) -> URL {
        endpoint.appendingPathComponent(sessionId.uuidString.lowercased())
    }

    static func failure(_ reason: UploadSession.FailureReason?) -> UploadFailure {
        switch reason {
        case .checksumMismatch: return .checksumMismatch
        case .invalidFile: return .invalidFile
        case .expired: return .expired
        case .storageError: return .storageError
        default: return .aborted
        }
    }
}

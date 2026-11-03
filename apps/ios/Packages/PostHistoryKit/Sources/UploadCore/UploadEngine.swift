import Foundation
import PostHistoryAPI

/// نواة الرفع: تدفع كل سجل عبر مراحله، وتستأنف من آخر موضع أكّده الخادم بعد الانقطاع وإنهاء التطبيق وإعادة تشغيل الجهاز.
/// كل الحالة في `UploadStateStore`؛ الرموز في `UploadSecretStore`؛ النقل عبر `TusTransport` (جلسة خلفية على الجهاز).
public actor UploadEngine: TusTransportDelegate {
    public struct Timing: Sendable {
        public var retryDelays: [TimeInterval] = [1, 2, 5, 10, 30, 60, 120]
        public var receiptPollInterval: TimeInterval = 3
        /// أقصى انتظار لأصل خلف النسخ الخفيفة (ADR 0075): نسخة عالقة لا تؤخر الأصول بلا حد. يبدأ من أول توقف للأصل
        /// في هذا التشغيل للتطبيق.
        public var proxyPriorityWindow: TimeInterval = 15 * 60
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
    /// أصول متوقفة عند إنشاء الجلسة لأن نسخة خفيفة في الطابور لها الأولوية (ADR 0075)؛ تُستأنف حين تنتهي النسخ الخفيفة.
    private var parkedForProxy: Set<UUID> = []
    /// متى بدأ كل أصل ينتظر النسخ الخفيفة؛ بعد `proxyPriorityWindow` يُرفع بلا انتظار.
    private var yieldingSince: [UUID: Date] = [:]
    /// مواد رُفع انتظار أصلها للنسخة الخفيفة (فشل التحضير، أو الأصل فقط، أو أُنهي التطبيق أثناء التحضير).
    private var releasedProxyHolds: Set<UUID> = []
    /// حد التجديدات المتتالية: رمز جديد ما زال يُرفض = مشكلة لا يحلها التجديد.
    static let maxIngestRefreshes = 3
    /// الحساب الداخل (ADR 0093): طلبات `/uploads` المصادَق عليها تُرسل باسمه، فسجل حساب آخر (أو والكل خارج) لا يطلبها بل ينتظر
    /// صاحبه، ونقل tus برمز الرفع يكمل. `nil`: بلا تمييز (الاختبارات، وما قبل أول ضبط).
    private var accountScope: AccountScope?
    /// سجلات تنتظر دخول صاحبها عند خطوة تحتاج طلبًا باسمه.
    private var parkedForAccount: Set<UUID> = []
    /// جيل المسح: يزيد مع كل `wipeAll()`. خطوة علّقت على انتظار (بصمة، أو طلب، أو نقل) لا تكتب سجلها ولا رمزه بعد أن تغيّر
    /// الجيل، فلا يعود سجل مُحي إلى الذاكرة ولا إلى القرص (ADR 0113).
    private var wipeGeneration: UInt64 = 0
    /// سجلات تحمل الآن مكانًا في الطابور (البصمة ثم الجلسة ثم الأجزاء)، لا أكثر من `policy.maxConcurrentTransfers`.
    private var transferSlots: Set<UUID> = []
    /// سجلات تنتظر مكانًا؛ تُمنح بترتيب الطابور (`transferOrder`): النسخ الخفيفة أولًا، ثم الأقدم دخولًا.
    private var waitingForSlot: Set<UUID> = []
    /// سجلات توقفت لأن قرص الهاتف امتلأ أثناء تجهيز جزء؛ تُعاد بعد مهلة، وتخرج من هنا بأول جزء يُجهَّز.
    private var outOfSpace: Set<UUID> = []
    /// جلسات سجلات ألغاها المراسل ولم يصل إجهاضها الخادم بعد (ADR 0113).
    private let aborts: any AbortStore
    private var drainingAborts = false
    private var abortDrainRequested = false

    public init(store: any UploadStateStore, secrets: any UploadSecretStore, api: any UploadAPI, transport: any TusTransport,
                ingestTokens: (any IngestTokenProvider)? = nil, aborts: (any AbortStore)? = nil,
                slicer: ChunkSlicer, policy: ChunkSizePolicy = ChunkSizePolicy(), timing: Timing = Timing(), environment: Environment = Environment()) {
        self.store = store
        self.secrets = secrets
        self.api = api
        self.transport = transport
        self.aborts = aborts ?? InMemoryAbortStore()
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
    /// `awaitsProxy`: أصل تُحضَّر نسخته الخفيفة الآن؛ يُبصم لكن لا تُنشأ جلسته حتى `releaseProxyHold` أو وصول النسخة إلى الطابور.
    @discardableResult
    public func enqueue(sourcePath: String, materialId: UUID, kind: UploadSessionCreate.Kind, filename: String, mimeType: String?, proxyMode: UploadSessionCreate.ProxyMode? = nil,
                        awaitsProxy: Bool = false, materialTitle: String? = nil, materialPriority: String? = nil,
                        ownerAccount: UUID? = nil) async throws -> UploadRecord {
        let url = resolve(sourcePath)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        var record = UploadRecord(materialId: materialId, kind: kind, proxyMode: proxyMode, sourcePath: sourcePath, filename: filename, mimeType: mimeType, sizeBytes: size, now: env.now())
        if awaitsProxy, kind == .original { record.awaitsProxy = true }
        record.materialTitle = materialTitle
        record.materialPriority = materialPriority
        record.ownerAccount = ownerAccount
        records[record.id] = record
        try store.save(record)
        // دوره في الطابور من لحظة دخوله، لا من لحظة بدء خطوته.
        waitingForSlot.insert(record.id)
        Task { await self.step(record.id) }
        return record
    }

    /// عند الإطلاق: يحمّل السجلات ويستأنف غير المكتمل. مهمة PATCH ما زالت في النظام لا تُعاد بل يُنتظر حدثها.
    public func resumeAll() async {
        await transport.setDelegate(self)
        for r in (try? store.loadAll()) ?? [] { records[r.id] = r }
        // تحضير النسخة الخفيفة لا ينجو من إنهاء التطبيق: أصل ينتظر نسخة لم تصل الطابور يُرفع بلا نسخة خفيفة.
        for rec in records.values where isHeldForProxy(rec) { releaseHold(rec.materialId) }
        let active = await transport.activePatchKeys()
        let resumable = records.values.filter { !$0.phase.isTerminal && $0.isPaused != true }
        // مهمة ما زالت في النظام تنقل الآن فتحمل مكانها ولو تجاوز العدد؛ وما عداها ينتظر دوره بترتيب الطابور.
        for rec in resumable where Self.holdsTransferSlot(rec.phase) {
            if rec.phase == .transferring, let off = rec.inFlightOffset, active.contains(TusTaskKey(uploadId: rec.id, offset: off)) {
                transferSlots.insert(rec.id)
            } else {
                waitingForSlot.insert(rec.id)
            }
        }
        for var rec in resumable {
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
        Task { await self.drainAborts() }
    }

    /// إيقاف مؤقت بطلب المراسل: تُلغى مهمة الجزء الجارية، ولا يُجدوَل جزء حتى `resume`. ما أكّده الخادم لا يضيع.
    public func pause(_ id: UUID) async {
        guard var rec = records[id], !rec.phase.isTerminal, rec.isPaused != true else { return }
        rec.isPaused = true
        rec.inFlightOffset = nil // نتيجة المهمة الملغاة إن وصلت لاحقًا تُهمَل كحدث قديم
        save(rec, settingPause: true)
        retryTasks[id]?.cancel()
        retryTasks[id] = nil
        // الموقوف لا يحجز مكانًا عن غيره؛ يعود إلى دوره حين يُستأنف.
        releaseSlot(id)
        await transport.cancel(uploadId: id)
        emit(.phaseChanged(id: id, phase: rec.phase))
    }

    /// الاستئناف من موضع الخادم (HEAD) إن كان النقل قد بدأ، وإلا من المرحلة التي توقف عندها.
    public func resume(_ id: UUID) async {
        guard var rec = records[id], rec.isPaused == true else { return }
        rec.isPaused = nil
        if rec.phase == .transferring { rec.inFlightOffset = nil }
        save(rec, settingPause: true)
        emit(.phaseChanged(id: id, phase: rec.phase))
        if rec.phase == .transferring { await resync(id) } else { await step(id) }
    }

    /// إعادة المحاولة بعد فشل نهائي: سجل جديد بجلسة جديدة للملف نفسه (البصمة تُحسب من جديد)، ويُزال السجل الفاشل.
    /// لا شيء إن كان الملف المحلي قد حُذف.
    @discardableResult
    public func retry(_ id: UUID) async throws -> UploadRecord? {
        guard let rec = records[id], case .failed = rec.phase, FileManager.default.fileExists(atPath: resolve(rec.sourcePath).path) else { return nil }
        let fresh = try await enqueue(sourcePath: rec.sourcePath, materialId: rec.materialId, kind: rec.kind, filename: rec.filename, mimeType: rec.mimeType,
                                      proxyMode: rec.proxyMode, materialTitle: rec.materialTitle, materialPriority: rec.materialPriority,
                                      ownerAccount: rec.ownerAccount)
        try? remove(id)
        return fresh
    }

    /// الحساب الداخل تغيّر (دخول، أو خروج، أو بدء التشغيل): ما كان ينتظر صاحبه وقد دخل يُستأنف من حيث وقف.
    public func setAccountScope(_ scope: AccountScope?) {
        accountScope = scope
        let ready = parkedForAccount.filter { id in records[id].map(mayRequest) ?? true }
        parkedForAccount.subtract(ready)
        for id in ready { Task { await self.step(id) } }
        // إجهاض ينتظر صاحبه يُرسل حين يدخل.
        Task { await self.drainAborts() }
    }

    /// السجلات التي تنتظر دخول صاحبها (للاختبارات).
    func waitingForOwner() -> Set<UUID> { parkedForAccount }

    /// تُرسل طلبات هذا السجل المصادَق عليها الآن: صاحبه هو الداخل.
    private func mayRequest(_ rec: UploadRecord) -> Bool { mayRequest(owner: rec.ownerAccount) }
    private func mayRequest(owner: UUID?) -> Bool { accountScope?.owns(owner) ?? true }

    /// قبل كل طلب باسم الحساب (إنشاء الجلسة، ورمز البوابة، والإكمال، وسؤال الإيصال): سجل غيره ينتظر صاحبه بلا فشل ولا محاولة.
    private func requireOwner(_ rec: UploadRecord) throws {
        guard mayRequest(rec) else { throw AwaitingOwner() }
    }

    /// تحضير النسخة الخفيفة انتهى أو فشل: أصل المادة لا ينتظرها بعد الآن.
    public func releaseProxyHold(materialId: UUID) {
        releaseHold(materialId)
        wakeParked()
    }

    /// الانتظار لا يُكتب في السجل (حلقة الدفع تحفظ نسختها منه): يُرفع في الذاكرة، ووصول النسخة إلى الطابور يرفعه أيضًا.
    private func releaseHold(_ materialId: UUID) { releasedProxyHolds.insert(materialId) }

    private func isHeldForProxy(_ rec: UploadRecord) -> Bool {
        rec.awaitsProxy == true && !releasedProxyHolds.contains(rec.materialId)
            && !records.values.contains { $0.kind == .proxy && $0.materialId == rec.materialId }
    }

    /// النسخة الخفيفة أولًا في كل الطابور: أصل لم تُنشأ جلسته ينتظر ما دامت نسخة خفيفة غير منتهية، أو نسخته قيد التحضير.
    func mustYieldToProxy(_ rec: UploadRecord) -> Bool {
        guard rec.kind == .original else { return false }
        guard isHeldForProxy(rec) || records.values.contains(where: { $0.kind == .proxy && !$0.phase.isTerminal }) else { return false }
        if let since = yieldingSince[rec.id], env.now().timeIntervalSince(since) >= timing.proxyPriorityWindow { return false }
        return true
    }

    private func park(_ rec: UploadRecord) {
        parkedForProxy.insert(rec.id)
        guard yieldingSince[rec.id] == nil else { return }
        yieldingSince[rec.id] = env.now()
        let id = rec.id, window = timing.proxyPriorityWindow, sleep = timing.sleep
        Task { [weak self] in
            try? await sleep(window)
            await self?.proxyWindowElapsed(id)
        }
    }

    private func proxyWindowElapsed(_ id: UUID) async {
        guard parkedForProxy.remove(id) != nil else { return }
        await step(id)
    }

    /// الأصول التي تنتظر الآن نسخة خفيفة (لتعرض الواجهة السبب بدل «جارٍ البدء»).
    public func waitingForProxy() -> Set<UUID> {
        Set(records.values.filter { $0.phase == .creatingSession && mustYieldToProxy($0) }.map(\.id))
    }

    private func wakeParked() {
        let ids = parkedForProxy
        parkedForProxy.removeAll()
        for id in ids { Task { await self.step(id) } }
    }

    /// الإلغاء يُكتب أولًا، قبل أي انتظار: حدث متأخر من النقل، أو خطوة معلّقة على طلب، تجد السجل منتهيًا فلا تعيده ولا تجدول جزءًا
    /// (`save` لا يكتب فوق سجل منتهٍ). ثم يُلغى النقل الجاري، وتُنهى الجلسة على الخادم باسم صاحبها (`DELETE /uploads/{id}`)، أو
    /// تُحفظ لتُرسل لاحقًا إن تعذّر الآن (ADR 0113، كما في أندرويد ADR 0112).
    public func cancel(_ id: UUID) async {
        guard var rec = records[id], !rec.phase.isTerminal else { return }
        retryTasks[id]?.cancel()
        retryTasks[id] = nil
        rec.inFlightOffset = nil
        setPhase(&rec, .cancelled)
        slicer.discardAll(uploadId: id)
        try? secrets.removeToken(for: id)
        await transport.cancel(uploadId: id)
        if let remote = rec.remote { await keepAbort(sessionId: remote.uploadSessionId, owner: rec.ownerAccount, record: id) }
        await forgetIngest(rec)
    }

    // MARK: إجهاض الجلسة على الخادم

    /// يُبقي إجهاض جلسة سجل ملغى ثم يرسل ما بقي. إن تعذّر الحفظ (الملف لا يُقرأ الآن) يُرسل مرة بلا حفظ، فلا يضيع إن كانت الشبكة متاحة.
    private func keepAbort(sessionId: UUID, owner: UUID?, record: UUID) async {
        let abort = PendingAbort(sessionId: sessionId, ownerAccount: owner, idempotencyKey: PendingAbort.idempotencyKey(forRecord: record), createdAt: env.now())
        do {
            try aborts.add(abort)
        } catch {
            if mayRequest(owner: owner) { _ = try? await api.abort(idempotencyKey: abort.idempotencyKey, id: sessionId) }
            return
        }
        await drainAborts()
    }

    /// يرسل الإجهاضات المحفوظة لأصحابها الداخلين، الأقدم أولًا، ويتوقف عند أول ما يُعاد لاحقًا (انقطاع، `5xx`، `429`): التالي سيلقاه
    /// أيضًا. الجواب الأخير يُسقطه: `204`، و`404` (غائبة أو لغيره)، و`409` (تحقّق أصلها قبل الإلغاء)، و`401`/`403` (المعترض حدّث
    /// الجلسة وأعاد الطلب من قبل؛ ما بقي منهما جلسة أُبطلت، والإبطال يمحو الطابور وإجهاضاته). يُستدعى عند الإلغاء والإطلاق والدخول
    /// وعودة التطبيق إلى المقدمة.
    public func drainAborts() async {
        guard !drainingAborts else { abortDrainRequested = true; return }
        drainingAborts = true
        defer { drainingAborts = false }
        let generation = wipeGeneration
        repeat {
            abortDrainRequested = false
            for abort in (try? aborts.all()) ?? [] {
                guard generation == wipeGeneration else { return }
                guard mayRequest(owner: abort.ownerAccount) else { continue }
                do {
                    try await api.abort(idempotencyKey: abort.idempotencyKey, id: abort.sessionId)
                } catch let e as UploadAPIError where !e.isRetryable {
                    // جواب أخير من الخادم: لا يُعاد.
                } catch {
                    break
                }
                guard generation == wipeGeneration else { return }
                try? aborts.remove(sessionId: abort.sessionId)
            }
        } while abortDrainRequested && generation == wipeGeneration
    }

    /// الإجهاضات التي لم تصل الخادم بعد.
    public func pendingAborts() -> [PendingAbort] { (try? aborts.all()) ?? [] }

    /// المسح الطارئ أو إبطال الجلسة: يلغي كل مهام النقل الخلفية ويحذف كل السجلات وملفات الأجزاء ورموز الرفع. لا يُسجَّل شيء.
    /// لا يلمس الملفات الأصلية؛ حذفها على طبقة التطبيق (`LocalDataWiper`).
    /// الطابور يُفرَّغ في الذاكرة ويتغيّر الجيل قبل أول انتظار: خطوة معلّقة تعود بعده لا تجد سجلها فلا تكتبه (ADR 0113).
    public func wipeAll() async -> Int {
        wipeGeneration &+= 1
        let wiped = records
        records.removeAll()
        for task in retryTasks.values { task.cancel() }
        retryTasks.removeAll()
        busy.removeAll()
        resyncing.removeAll()
        parkedForProxy.removeAll()
        parkedForAccount.removeAll()
        yieldingSince.removeAll()
        releasedProxyHolds.removeAll()
        ingestRefreshes.removeAll()
        transferSlots.removeAll()
        waitingForSlot.removeAll()
        outOfSpace.removeAll()
        // لا إجهاض ينتظر بعد المسح: لا يبقى أثر لجلسة على الهاتف (والمسح الطارئ يبطل الجلسات على الخادم بأفضل جهد).
        try? aborts.removeAll()
        for (id, rec) in wiped {
            await transport.cancel(uploadId: id)
            await forgetIngest(rec)
            slicer.discardAll(uploadId: id)
            try? secrets.removeToken(for: id)
            try? store.remove(id: id)
        }
        return wiped.count
    }

    /// يحذف سجلًا منتهيًا وآثاره (لا يحذف الملف الأصلي؛ حذفه قرار المراسل في الواجهة).
    public func remove(_ id: UUID) throws {
        guard let rec = records[id], rec.phase.isTerminal else { return }
        slicer.discardAll(uploadId: id)
        try? secrets.removeToken(for: id)
        try store.remove(id: id)
        records[id] = nil
        releaseSlot(id)
        outOfSpace.remove(id)
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
            // `5xx` و`429` و`423`: موضع الخادم أولًا (HEAD) فلا يبدأ شيء من الصفر، ثم مهلة متزايدة قبل الجزء التالي.
            await resync(rec.id, backoff: error.wantsBackoff)
        }
    }

    // MARK: الدفع

    /// كل انتظار في الخطوة (بصمة، أو طلب، أو نقل) قد يمر عليه مسح أو إلغاء أو حذف؛ النسخة المحلية من السجل لا تُكتب بعده
    /// إلا والسجل حي في الجيل نفسه (`isCurrent`).
    private func step(_ id: UUID) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        let generation = wipeGeneration
        while var rec = records[id], !rec.phase.isTerminal, rec.isPaused != true {
            do {
                switch rec.phase {
                case .hashing:
                    guard takeSlot(rec) else { return }
                    let source = try sourceURL(rec)
                    let hasher = env.hasher
                    rec.sha256Hex = try await Task.detached(priority: .utility) { try hasher(source) }.value
                    guard isCurrent(id, generation) else { return }
                    setPhase(&rec, .creatingSession)
                case .creatingSession:
                    if mustYieldToProxy(rec) { releaseSlot(id); park(rec); return }
                    try requireOwner(rec)
                    guard takeSlot(rec) else { return }
                    let body = UploadSessionCreate(materialId: rec.materialId, kind: rec.kind, sizeBytes: Int(rec.sizeBytes), filename: rec.filename, mimeType: rec.mimeType, proxyMode: rec.proxyMode, clientSha256: rec.sha256Hex)
                    let created = try await api.createSession(idempotencyKey: rec.createIdempotencyKey, body)
                    // مُسح الطابور أو أُلغي السجل أثناء الطلب: لا رمز رفع ولا سجل يُكتب له. والجلسة التي أنشأها هذا الطلب لسجل
                    // ألغاه المراسل لا تفلت من الإجهاض (الإلغاء لم يرها).
                    guard isCurrent(id, generation) else {
                        if generation == wipeGeneration, records[id].map({ $0.phase == .cancelled }) ?? true {
                            await keepAbort(sessionId: created.id, owner: rec.ownerAccount, record: id)
                        }
                        return
                    }
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
                    guard takeSlot(rec) else { return }
                    let uploadToken = try token(rec.id)
                    let ingestToken = try await ingestToken(rec, forceRefresh: false)
                    guard isCurrent(id, generation) else { await forgetIngest(rec); return }
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
                    guard isCurrent(id, generation) else { return }
                    setPhase(&rec, .transferring)
                case .transferring:
                    if rec.confirmedOffset >= rec.sizeBytes { setPhase(&rec, .completing); continue }
                    if rec.inFlightOffset != nil || resyncing.contains(id) { return } // بانتظار حدث النقل أو موضع الخادم
                    guard takeSlot(rec) else { return }
                    try prepareWindow(&rec)
                    outOfSpace.remove(id)
                    guard let chunk = rec.prepared.first, let uploadURL = rec.tusUploadURL else { throw UploadError.sourceTruncated }
                    let ingestToken = try await ingestToken(rec, forceRefresh: false)
                    guard isCurrent(id, generation) else { await forgetIngest(rec); return }
                    let request = TusPatchRequest(key: TusTaskKey(uploadId: rec.id, offset: chunk.offset), uploadURL: uploadURL, token: try token(rec.id), chunk: chunk, chunkFile: slicer.url(of: chunk), ingestToken: ingestToken)
                    rec.inFlightOffset = chunk.offset
                    save(rec)
                    try await transport.schedulePatch(request)
                    // مُسح الطابور أو أُلغي السجل أو حُذف أثناء الجدولة: إلغاء النقل سبق تسجيل المهمة، فيُلغى الجزء الآن.
                    guard isCurrent(id, generation) else { await transport.cancel(uploadId: id); return }
                    // أُوقف الرفع أثناء الجدولة: الإلغاء سبق تسجيل المهمة، فيُلغى الجزء الآن.
                    if records[id]?.isPaused == true { await transport.cancel(uploadId: id); return }
                    // قد تصل نتيجة الجزء أثناء الجدولة (والمستدعي من الحدث يجد السجل مشغولًا)؛ تُعاد قراءة الحالة بدل الخروج.
                    continue
                case .completing:
                    guard let remote = rec.remote else { throw UploadAPIError.notFound }
                    try requireOwner(rec)
                    do { try await api.complete(idempotencyKey: rec.completeIdempotencyKey, id: remote.uploadSessionId, reportedSha256: rec.sha256Hex) }
                    catch UploadAPIError.conflict {} // مسار tusd: الاكتمال يصل من الخطّاف؛ نكتفي بانتظار التحقق
                    guard isCurrent(id, generation) else { return }
                    setPhase(&rec, .awaitingReceipt)
                case .awaitingReceipt:
                    guard let remote = rec.remote else { throw UploadAPIError.notFound }
                    try requireOwner(rec)
                    let session = try await api.session(id: remote.uploadSessionId)
                    guard isCurrent(id, generation) else { return }
                    switch session.state {
                    case .verified:
                        try? secrets.removeToken(for: rec.id)
                        await forgetIngest(rec)
                        guard isCurrent(id, generation) else { return }
                        setPhase(&rec, .verified(receiptNumber: session.receiptNumber ?? ""))
                    case .deduplicated:
                        try? secrets.removeToken(for: rec.id)
                        await forgetIngest(rec)
                        guard isCurrent(id, generation) else { return }
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
                // خطأ وصل بعد مسح أو إلغاء: لا فشل ولا محاولة تُكتب لسجل لم يعد في الطابور.
                guard isCurrent(id, generation) else { return }
                await fail(or: error, id: id)
                return
            }
        }
    }

    /// السجل ما زال حيًّا بعد انتظار: لم يمحه مسح (الجيل نفسه)، ولم يُحذف، ولم ينتهِ (إلغاء أو فشل من حدث النقل).
    private func isCurrent(_ id: UUID, _ generation: UInt64) -> Bool {
        generation == wipeGeneration && records[id].map { !$0.phase.isTerminal } == true
    }

    // MARK: أماكن الطابور

    /// المراحل التي تحمل مكانًا: البصمة (قراءة الأصل كاملًا) والجلسة والأجزاء على القرص. الإكمال وانتظار الإيصال طلبات قصيرة لا تحمله.
    static func holdsTransferSlot(_ phase: UploadPhase) -> Bool {
        switch phase {
        case .hashing, .creatingSession, .creatingUpload, .transferring: return true
        default: return false
        }
    }

    /// ترتيب الطابور (ADR 0113): النسخ الخفيفة أولًا (ADR 0075)، ثم الأقدم دخولًا.
    static func transferOrder(_ a: UploadRecord, _ b: UploadRecord) -> Bool {
        if (a.kind == .proxy) != (b.kind == .proxy) { return a.kind == .proxy }
        if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
        return a.id.uuidString < b.id.uuidString
    }

    /// يأخذ السجل مكانه إن كان دوره وفي الطابور مكان، وإلا ينتظر (`grantSlots` يوقظه). حامل المكان عند حدّ جزء يتخلى عنه لمن
    /// يسبقه في الترتيب وينتظر والأماكن ممتلئة: نسخة خفيفة، أو سجل عاد من مهلة إعادة المحاولة.
    private func takeSlot(_ rec: UploadRecord) -> Bool {
        let id = rec.id
        // المستدعي في خطوته الآن: لا ينتظر صاحبه ولا نسخة خفيفة.
        parkedForAccount.remove(id)
        parkedForProxy.remove(id)
        if transferSlots.contains(id) {
            guard yieldsSlot(rec) else { return true }
            transferSlots.remove(id)
        }
        waitingForSlot.insert(id)
        grantSlots(caller: id)
        return transferSlots.contains(id)
    }

    private func yieldsSlot(_ rec: UploadRecord) -> Bool {
        guard rec.phase == .transferring, rec.inFlightOffset == nil, transferSlots.count >= policy.maxConcurrentTransfers else { return false }
        return waitingForSlot.contains { other in records[other].map { mayTakeSlot($0) && Self.transferOrder($0, rec) } ?? false }
    }

    /// سجل ينتظر مكانًا ويستطيع أن يتقدم إن أخذه: لا موقوف ولا منتهٍ ولا ينتظر صاحبه أو نسخة خفيفة.
    private func mayTakeSlot(_ rec: UploadRecord) -> Bool {
        !rec.phase.isTerminal && rec.isPaused != true && Self.holdsTransferSlot(rec.phase)
            && !parkedForAccount.contains(rec.id) && !parkedForProxy.contains(rec.id)
    }

    /// يمنح الأماكن الشاغرة لمن ينتظر بترتيب الطابور ويوقظ خطوته (عدا المستدعي، فهو في خطوته الآن).
    private func grantSlots(caller: UUID? = nil) {
        waitingForSlot = waitingForSlot.filter { records[$0].map(mayTakeSlot) ?? false }
        while transferSlots.count < policy.maxConcurrentTransfers,
              let next = waitingForSlot.compactMap({ records[$0] }).min(by: Self.transferOrder) {
            waitingForSlot.remove(next.id)
            transferSlots.insert(next.id)
            if next.id != caller { Task { await self.step(next.id) } }
        }
    }

    private func releaseSlot(_ id: UUID) {
        waitingForSlot.remove(id)
        guard transferSlots.remove(id) != nil else { return }
        grantSlots()
    }

    /// ما ينتظر دوره في الطابور الآن (لتعرض الواجهة «بانتظار دوره» بدل «جارٍ التحضير»).
    public func waitingForTransferSlot() -> Set<UUID> {
        waitingForSlot.filter { records[$0].map(mayTakeSlot) ?? false }
    }

    /// ما توقف لأن قرص الهاتف ممتلئ، ويُعاد بعد مهلة.
    public func waitingForSpace() -> Set<UUID> { outOfSpace }

    /// يصنّف الخطأ: نهائي ← `failed`؛ قابل للإعادة ← محاولة بعد مهلة متزايدة.
    private func fail(or error: any Error, id: UUID) async {
        guard var rec = records[id] else { return }
        if error is AwaitingOwner {
            // ليس خطأ: يُستأنف حين يدخل صاحبه (`setAccountScope`)، ولا تُستهلك محاولة، ولا يحجز مكانًا عن غيره.
            parkedForAccount.insert(id)
            releaseSlot(id)
            return
        }
        rec.lastErrorCode = String(describing: error)
        switch error {
        case _ where UploadError.isOutOfSpace(error):
            // القرص ممتلئ أثناء تجهيز جزء: الأصل سليم وما وصل الخادم باقٍ، فلا فشل نهائي ولا «الملف غير موجود»؛
            // يُعاد بعد مهلة متزايدة، والواجهة تقول السبب (`waitingForSpace`).
            rec.lastErrorCode = String(describing: UploadError.outOfSpace)
            outOfSpace.insert(id)
            save(rec)
            scheduleRetry(id)
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
        // سجل ينتظر مهلته لا يوقف الطابور: مكانه لمن ينتظر، ويعود إلى دوره بترتيبه حين تنقضي (وحامل مكانه يتخلى عنه عند حدّ جزء).
        if !waitingForSlot.isEmpty { releaseSlot(id) }
        emit(.retryScheduled(id: id, attempt: rec.attempt, after: delay))
        retryTasks[id]?.cancel()
        retryTasks[id] = Task { [timing] in
            guard (try? await timing.sleep(delay)) != nil else { return }
            await self.step(id)
        }
    }

    /// يسأل الخادم عن موضعه (HEAD) ويُعيد مواءمة الأجزاء المُجهَّزة، ثم يستأنف. `backoff`: الخادم مشغول، فالجزء التالي بعد مهلة.
    private func resync(_ id: UUID, refreshIngest: Bool = false, backoff: Bool = false) async {
        guard let rec = records[id], rec.phase == .transferring, rec.inFlightOffset == nil, let url = rec.tusUploadURL, !resyncing.contains(id),
              rec.isPaused != true else { return }
        let generation = wipeGeneration
        resyncing.insert(id)
        let head: Result<Int64, any Error>
        do {
            let ingestToken = try await ingestToken(rec, forceRefresh: refreshIngest)
            head = .success(try await transport.currentOffset(uploadURL: url, token: try token(id), ingestToken: ingestToken))
        } catch { head = .failure(error) }
        resyncing.remove(id)
        guard generation == wipeGeneration, var rec = records[id], rec.phase == .transferring else { return }
        switch head {
        case .success(let serverOffset):
            applyServerOffset(&rec, serverOffset)
            save(rec)
            emit(.progress(id: id, confirmedOffset: rec.confirmedOffset, sizeBytes: rec.sizeBytes))
            if rec.attempt == 0, !backoff { await step(id) } else { scheduleRetry(id) }
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

    /// يجهّز الأجزاء حتى امتلاء النافذة ضمن ميزانية الطابور المشتركة، ويعيد تجهيز ما فُقد ملفه (مثلًا بعد إعادة تشغيل الجهاز).
    /// أجزاء السجلات الأخرى على القرص (الجارية والموقوفة) تُحسب من الميزانية.
    private func prepareWindow(_ rec: inout UploadRecord) throws {
        let source = try sourceURL(rec)
        if let i = rec.prepared.firstIndex(where: { !slicer.exists($0) }) { rec.prepared.removeSubrange(i...) }
        let id = rec.id
        let onDisk = records.values.reduce(Int64(0)) { sum, other in other.id == id ? sum : sum + Self.preparedBytes(other) }
        let budget = policy.sharedChunkBudgetBytes - onDisk - Self.preparedBytes(rec)
        for (offset, length) in ChunkPlanner.chunksToPrepare(sizeBytes: rec.sizeBytes, confirmedOffset: rec.confirmedOffset, chunkSize: rec.chunkSizeBytes,
                                                             prepared: rec.prepared, window: policy.preparedWindow, budgetBytes: budget) {
            rec.prepared.append(try slicer.prepare(uploadId: rec.id, source: source, offset: offset, length: length))
        }
    }

    static func preparedBytes(_ rec: UploadRecord) -> Int64 { rec.prepared.reduce(0) { $0 + $1.length } }

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
        try requireOwner(rec)
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
        guard records[rec.id] != nil else { return }
        rec.phase = phase
        if phase.isTerminal {
            rec.inFlightOffset = nil
            // أجزاء سجل انتهى لا تُرسل أبدًا (إعادة المحاولة سجل جديد): تُحذف فلا تشغل القرص ولا ميزانية الطابور.
            rec.prepared.forEach(slicer.discard)
            rec.prepared = []
            outOfSpace.remove(rec.id)
        }
        save(rec)
        emit(.phaseChanged(id: rec.id, phase: phase))
        if !Self.holdsTransferSlot(phase) { releaseSlot(rec.id) }
        if rec.kind == .proxy, phase.isTerminal { wakeParked() }
    }

    /// `pause` و`resume` وحدهما يغيّران علم الإيقاف؛ أي حفظ آخر (نسخة محلية قديمة بعد انتظار) يُبقي العلم المخزَّن،
    /// والمسجَّل الموقوف لا يحمل جزءًا جاريًا. سجل ليس في الطابور (مُحي أو حُذف) لا يُكتب: لا يعود بنسخة محلية قديمة.
    /// والسجل المنتهي (ملغى أو متحقق أو فاشل) لا يُكتب فوقه: إعادة المحاولة سجل جديد.
    private func save(_ rec: UploadRecord, settingPause: Bool = false) {
        guard let current = records[rec.id], !current.phase.isTerminal else { return }
        var r = rec
        if !settingPause, let stored = records[r.id] {
            r.isPaused = stored.isPaused
            if stored.isPaused == true { r.inFlightOffset = nil }
        }
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

/// سجل ينتظر دخول صاحبه قبل طلب باسمه (ADR 0093). ليس فشلًا.
struct AwaitingOwner: Error, Equatable {}

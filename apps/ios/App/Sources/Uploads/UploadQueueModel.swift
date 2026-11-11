import Accessibility
import Foundation
import MaterialsCore
import MediaCore
import Network
import PostHistoryAPI
import SwiftUI
import UIKit
import UploadCore

/// طابور الرفع كما تراه الواجهة؛ يراقب أحداث النواة ويطبّق قرار الحذف المحلي.
@MainActor
final class UploadQueueModel: ObservableObject {
    /// من الداخل الآن (ADR 0093): يحدد ما يُعرض من السجلات والإرسالات والإيصالات، وباسم من تطلب النواة.
    @Published private(set) var scope = AccountScope()
    /// ما يُعرض: سجلات الحساب الداخل وحده. سجلات غيره تُرفع في الخلفية ولا يظهر عنها شيء (لا عنوان ولا مصغّرة ولا عدد).
    @Published private(set) var records: [UploadRecord] = []
    /// كل سجلات الطابور لكل الحسابات، لقرارات الطابور وحدها (الإيصال، والنسخ نصف المكتوبة)؛ لا تصل الشاشات.
    private var allRecords: [UploadRecord] = []
    @Published private(set) var localCopies: Set<UUID> = []
    /// أصول تنتظر نسخة خفيفة في الطابور، ومواد تُحضَّر نسختها الآن (ADR 0075).
    @Published private(set) var waitingForProxy: Set<UUID> = []
    @Published private(set) var preparingProxy: Set<UUID> = []
    /// سجلات تنتظر دورها في الطابور، وسجلات توقفت لأن مساحة الهاتف ممتلئة (ADR 0113).
    @Published private(set) var queuedForTransfer: Set<UUID> = []
    @Published private(set) var waitingForSpace: Set<UUID> = []
    /// ما لم يستطع التخزين المحلي قراءته أو حفظه (ADR 0113): أعداد وحدها، تعرضها ملاحظة شاشة الرفع.
    @Published private(set) var storageHealth = UploadStorageHealth()
    /// الشبكة كما تراها بطاقة الرفع (المواصفة A2): بلا شبكة، أو بانتظار Wi‑Fi حين يكون «Wi‑Fi فقط» مفعّلًا.
    enum NetworkState: Equatable { case online, offline, waitingForWifi }
    @Published private(set) var networkState: NetworkState = .online
    /// الزمن المتبقي التقديري لكل سجل من سرعة آخر 30 ثانية؛ يغيب بلا عيّنات كافية أو بلا شبكة.
    @Published private(set) var etaSeconds: [UUID: TimeInterval] = [:]
    /// مسودات «مادة جديدة» للحساب الداخل وحده (ADR 0113، متابعة ADR 0093): مسودة غيره على الهاتف المشترك لا تظهر.
    @Published private(set) var drafts: [MaterialDraft] = []
    /// كل المسودات على القرص لكل الحسابات؛ لا تصل الشاشات.
    private var allDrafts: [MaterialDraft] = []
    /// إيصال وصل للتو: يُعرض شاشة الإيصال تلقائيًا، مرة للإرسالة كلها حين يصل آخر ملفاتها (06، ADR 0088). للحساب الداخل
    /// وحده: إيصال غيره ينتظر صاحبه (`ReceiptInbox`، ADR 0093).
    @Published var presentedReceipt: ReceiptTarget?
    /// الإرسالات الأخيرة للحساب الداخل، الأحدث أولًا: تجمع ملفات الإرسالة الواحدة في دوائر واحدة وإيصال واحد. من `ledger.batches`.
    @Published private(set) var batches: [SendBatch] = []
    private var inbox = ReceiptInbox<ReceiptTarget>()
    let engine: UploadEngine
    let settings: AppSettings
    let draftStore: FileDraftStore?
    /// الإرسالات بحماية سجلات الرفع نفسها، وآخر حالة جيدة في الذاكرة لا تمحوها قراءة فاشلة والهاتف مقفل (ADR 0088).
    private let ledger: SendBatchLedger
    private let transcoder: any ProxyTranscoder = AVFoundationProxyTranscoder()
    private var proxyTasks: [UUID: Task<Void, Never>] = [:]
    private var watcher: Task<Void, Never>?
    private var estimators: [UUID: TransferRateEstimator] = [:]
    private var pathMonitor: NWPathMonitor?
    private var lastPath: (satisfied: Bool, expensive: Bool, constrained: Bool) = (true, false, false)

    init(engine: UploadEngine, settings: AppSettings) {
        self.engine = engine
        self.settings = settings
        draftStore = try? FileDraftStore(directory: UploadServices.shared.draftsDirectory)
        ledger = SendBatchLedger(store: SendBatchStore(fileURL: UploadServices.shared.batchesFile))
        // النطاق بلا أحد حتى يُضبط (`setScope`)، فلا تظهر مسودة قبل أن يُعرف الداخل.
        allDrafts = draftStore?.loadAllIfReadable() ?? []
        // نسخ الاختيار المؤقتة التي خلّفها إنهاء التطبيق قبل نقلها إلى مجلد الرفع.
        PickedTempFiles.sweep(in: FileManager.default.temporaryDirectory)
    }

    private func startPathMonitor() {
        pathMonitor?.cancel()
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let snapshot = (path.status == .satisfied, path.isExpensive, path.isConstrained)
            Task { @MainActor in self?.lastPath = snapshot; self?.updateNetworkState() }
        }
        monitor.start(queue: DispatchQueue(label: "net.palpost.posthistory.uploads.path"))
        pathMonitor = monitor
    }

    func updateNetworkState() {
        let was = networkState
        if !lastPath.satisfied { networkState = .offline }
        else if settings.uploadOverWifiOnly, lastPath.expensive || lastPath.constrained { networkState = .waitingForWifi }
        else { networkState = .online }
        // عادت الشبكة: إجهاض جلسة ألغاها المراسل وهو بلا شبكة يُرسل الآن (ADR 0113).
        if was != .online, lastPath.satisfied { Task { await engine.drainAborts() } }
        if networkState != .online { etaSeconds = [:]; for id in estimators.keys { estimators[id]?.reset() } }
    }

    func start() {
        watcher?.cancel()
        watcher = Task { [weak self] in
            guard let self else { return }
            let stream = await engine.events()
            await engine.resumeAll()
            await refresh()
            removeHalfWrittenLightCopies()
            startPathMonitor()
            for await event in stream {
                switch event {
                case .phaseChanged(let id, let phase):
                    SafeLog.phase(id, phase)
                    if case .verified = phase { await receiptArrived(id) }
                    if case .deduplicated = phase { await receiptArrived(id) }
                    if phase.isTerminal { estimators[id] = nil; etaSeconds[id] = nil }
                case .progress(let id, let confirmed, let size):
                    estimators[id, default: TransferRateEstimator()].record(offset: confirmed, at: Date())
                    etaSeconds[id] = networkState == .online ? estimators[id]?.secondsRemaining(sizeBytes: size, confirmedOffset: confirmed) : nil
                case .retryScheduled:
                    break
                case .storageHealthChanged:
                    // القيمة نفسها تُقرأ في `refresh()` أدناه؛ لا يُسجَّل شيء.
                    break
                }
                await refresh()
            }
        }
    }

    func refresh() async {
        allRecords = await engine.allRecords()
        waitingForProxy = await engine.waitingForProxy()
        queuedForTransfer = await engine.waitingForTransferSlot()
        waitingForSpace = await engine.waitingForSpace()
        let health = await engine.storageHealth()
        if health != storageHealth { storageHealth = health }
        publishVisible()
    }

    /// ما تراه الشاشات من سجلات الطابور وإرسالاته ومسوداته: للحساب الداخل وحده (`AccountScope`).
    private func publishVisible() {
        let before = records.map { item($0) }
        records = scope.visible(allRecords)
        localCopies = Set(records.filter { UploadServices.shared.localCopyExists(relativePath: $0.sourcePath) }.map(\.id))
        batches = scope.visible(ledger.batches)
        drafts = scope.visible(allDrafts)
        announce(UploadAnnouncement.changes(from: before, to: records.map { item($0) }))
    }

    /// يقول لقارئ الشاشة أن رفعًا تعذّر أو توقف أو وصل، مرة عند الانتقال (`UploadAnnouncement`)، ولا يقول شيئًا لكل نسبة.
    /// النص عام من الكتالوج: لا عنوان مادة ولا اسم ملف ولا رقم إيصال. بلا قارئ شاشة لا يحدث شيء.
    private func announce(_ changes: [UploadAnnouncement]) {
        for change in changes {
            AccessibilityNotification.Announcement(String(localized: String.LocalizationValue(change.textKey))).post()
        }
    }

    /// الدخول والخروج وبدء التشغيل (ADR 0093): النواة تطلب باسم الداخل وحده، والشاشات ترى سجلاته وحده. الإيصال المعروض لغيره
    /// يعود إلى انتظار صاحبه، وما ينتظر الداخل يُعرض الآن.
    func setScope(_ new: AccountScope) async {
        if let shown = presentedReceipt, !new.owns(shown.owner) {
            inbox.hold(shown, owner: shown.owner)
            presentedReceipt = nil
        }
        scope = new
        await engine.setAccountScope(new)
        await refresh()
        if presentedReceipt == nil { showWaitingReceipt() }
    }

    /// أصول الحساب الداخل التي لم تنتهِ: تُكمل في الخلفية بعد الخروج، فيسأل الخروج أولًا إن وُجد منها شيء.
    var pendingUploadsAtLogout: Int { scope.pendingOriginals(allRecords) }

    /// عودة المشهد نشطًا (الهاتف مفتوح): يُعاد ما تعذّرت قراءته في إطلاق خلفي والهاتف مقفل؛ قراءة فاشلة لا تمحو شيئًا.
    func reloadFromDisk() {
        ledger.refresh()
        batches = scope.visible(ledger.batches)
        reloadDrafts()
        Task { await engine.drainAborts() }
    }

    private func receiptArrived(_ id: UUID) async {
        guard let rec = await engine.record(id) else { return }
        if rec.kind == .original {
            await refresh()
            presentReceiptIfDue(for: rec)
        }
        // النسخة الخفيفة مشتقة يصنعها التطبيق: تُحذف دائمًا بعد إيصالها. الأصل قرار المراسل، وبعد التحقق وحده (`LocalCopyPolicy`).
        guard rec.kind == .proxy || (settings.deleteLocalAfterReceipt && LocalCopyPolicy.mayDelete(record: rec)) else { return }
        UploadServices.shared.deleteLocalCopy(relativePath: rec.sourcePath)
    }

    /// ملف من إرسالة: يُعرض إيصالها مرة حين يصل كل ما بقي منها وقد أُغلقت حلقتها. ملف بلا إرسالة («لقطة بديلة» أو من إصدار سابق):
    /// إيصاله وحده. القرار في `SendBatchLedger` (MaterialsCore، مختبر)؛ والقراءة قبله لا تمحو شيئًا إن كان الملف لا يُقرأ.
    private func presentReceiptIfDue(for rec: UploadRecord) {
        ledger.refresh()
        present(ledger.receiptDue(forMaterial: rec.materialId) { items(of: $0) }, record: rec)
    }

    /// إيصال استحق: يُعرض للحساب الداخل إن كان صاحبه، وإلا ينتظر صاحبه (ADR 0093).
    private func present(_ due: SendBatchLedger.ReceiptScope?, record rec: UploadRecord?) {
        if let target = receiptTarget(due, record: rec), let now = inbox.arrive(target, owner: target.owner, scope: scope) { show(now) }
        batches = scope.visible(ledger.batches)
    }

    private func receiptTarget(_ due: SendBatchLedger.ReceiptScope?, record rec: UploadRecord?) -> ReceiptTarget? {
        switch due {
        case .material(let materialId)?:
            return ReceiptTarget(materialId: materialId, recordId: rec?.id, owner: rec?.ownerAccount)
        case .batch(let batchId)?:
            let batch = ledger.batches.first { $0.id == batchId }
            guard let materialId = rec?.materialId ?? batch?.materialIds.last else { return nil }
            return ReceiptTarget(materialId: materialId, recordId: rec?.id, batchId: batchId, owner: batch?.owner ?? rec?.ownerAccount)
        case nil:
            return nil
        }
    }

    /// يعرض إيصالًا للحساب الداخل. إيصال الإرسالة يُعلَّم في الذاكرة قبل العرض: لا يتكرر ولو تعذّر الحفظ.
    private func show(_ target: ReceiptTarget) {
        if let batchId = target.batchId { ledger.markReceiptShown(batchId) }
        presentedReceipt = target
    }

    /// بعد الدخول، أو بعد إغلاق إيصال: أقدم ما ينتظر الحساب الداخل، ثم إيصال إرسالة له استحق وهو خارج (من سجلها).
    private func showWaitingReceipt() {
        if let next = inbox.next(for: scope) { return show(next) }
        guard let owner = scope.current, let batchId = ledger.receiptsDue(forOwner: owner, items: { items(of: $0) }).first else { return }
        present(.batch(batchId), record: nil)
    }

    /// الإيصال المعروض أُغلق: يتبعه ما ينتظر الحساب الداخل، بعد أن تكتمل حركة الإغلاق.
    func receiptDismissed() {
        presentedReceipt = nil
        Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if presentedReceipt == nil { showWaitingReceipt() }
        }
    }

    /// الإيصال يدويًا من تفاصيل مادة («عرض الإيصال»): للحساب الداخل.
    func showReceipt(materialId: UUID, recordId: UUID?) {
        presentedReceipt = ReceiptTarget(materialId: materialId, recordId: recordId, owner: scope.current)
    }

    /// المسح الطارئ والإبطال: لا إيصال ينتظر أحدًا.
    func forgetWaitingReceipts() {
        inbox.removeAll()
        presentedReceipt = nil
    }

    // MARK: الإرسالات وما تعرضه الشاشات

    /// «أرسل N مواد» (`BatchedSubmission`): الإرسالة تُسجَّل بمفاتيح ملفاتها قبل أول طلب، ومادة كل ملف تُضاف إليها قبل أن يدخل
    /// الطابور، وتُغلق بعد الحلقة. فإن وصلت ملفاتها كلها أثناء الحلقة يُعرض إيصالها الواحد عند الإغلاق.
    /// المسودة تُحفظ بعد كل خطوة (ADR 0113): إنهاء التطبيق أثناء الإرسال يترك على القرص ما بقي بمواد ما أُنشئ منه، فإعادة الإرسال
    /// لا تنشئ مادة ولا تُدخل ملفًا مرتين.
    func submit(_ draft: MaterialDraft, dynamicFields: [String: JSONValue], lightCopy: ProxyChoice,
                create: (String, MaterialCreate) async throws -> UUID) async -> BatchedSubmission.Outcome {
        let owner = draft.owner ?? scope.current
        let result = await BatchedSubmission.run(draft, dynamicFields: dynamicFields, ledger: ledger, owner: scope.current, create: create, enqueue: { file, materialId, body in
            batches = scope.visible(ledger.batches)
            // أُنهي التطبيق بين إدخال الملف وحفظ المسودة: أصل المادة في الطابور، فلا يُدخل ثانية.
            let inQueue = await engine.allRecords()
            guard !inQueue.contains(where: { $0.materialId == materialId && $0.kind == .original && $0.phase != .cancelled }) else { return }
            try await enqueue(relativePath: file.relativePath, materialId: materialId, filename: file.filename, mimeType: file.mimeType,
                              lightCopy: file.isVideo ? lightCopy : .originalOnly, title: body.title, priority: body.priority)
        }, persist: { [draftStore] snapshot in
            guard let draftStore else { return }
            guard !snapshot.files.isEmpty else { draftStore.delete(snapshot.id); return }
            var d = snapshot
            d.owner = owner
            d.updatedAt = Date()
            try draftStore.save(d)
        })
        await refresh()
        present(ledger.receiptDue(forBatch: result.batchId) { items(of: $0) }, record: nil)
        return result
    }

    /// الإبطال والمسح: لا تبقى إرسالات تشير إلى طابور مُحي.
    func forgetBatches() {
        ledger.forgetAll()
        batches = []
    }

    var originals: [UploadRecord] { records.filter { $0.kind == .original } }

    /// أصول الإرسالة كما تحسبها شاشة الرفع (لقرار الإيصال)، من كل الطابور: إرسالة حساب خارج تُحسب كما هي لا فارغة.
    private func items(of batch: SendBatch) -> [UploadItem] {
        let ids = Set(batch.materialIds)
        return allRecords.filter { $0.kind == .original && ids.contains($0.materialId) }.map { item($0) }
    }

    func originals(of batch: SendBatch) -> [UploadRecord] {
        let ids = Set(batch.materialIds)
        return originals.filter { ids.contains($0.materialId) }.sorted { $0.createdAt < $1.createdAt }
    }

    /// شاشة الرفع (05): ملفات آخر إرسالة، وكل ملف لم ينتهِ أو فشل من غيرها.
    var uploadScreenRecords: [UploadRecord] {
        let latest = Set(batches.first?.materialIds ?? [])
        return originals.filter { rec in
            if latest.contains(rec.materialId) { return true }
            if case .failed = rec.phase { return true }
            return !rec.phase.isTerminal
        }
        .sorted { $0.createdAt < $1.createdAt }
    }

    /// «آخر الإرسالات» في الرئيسية: أحدث خمسة أصول.
    var recentOriginals: [UploadRecord] { Array(originals.filter { $0.phase != .cancelled }.sorted { $0.createdAt > $1.createdAt }.prefix(5)) }

    var hasActiveUploads: Bool { originals.contains { !$0.phase.isTerminal } }

    /// السجل كما تحسبه شاشة الرفع: الحالة وما وصل، ووصول نسخته الخفيفة.
    func item(_ rec: UploadRecord) -> UploadItem {
        let state: UploadItem.State
        switch rec.phase {
        case .hashing, .creatingSession, .creatingUpload: state = .preparing
        case .transferring: state = .transferring
        case .completing, .awaitingReceipt: state = .finishing
        case .verified, .deduplicated: state = .arrived
        case .failed: state = .failed
        case .cancelled: state = .cancelled
        }
        let previewArrived = allRecords.contains { $0.kind == .proxy && $0.materialId == rec.materialId && $0.phase.isVerified }
        return UploadItem(id: rec.id, materialId: rec.materialId, sizeBytes: rec.sizeBytes, confirmedOffset: rec.confirmedOffset,
                          state: state, paused: rec.isPaused == true, previewArrived: previewArrived,
                          queued: queuedForTransfer.contains(rec.id), waitingForSpace: waitingForSpace.contains(rec.id))
    }

    /// «اختيار الملف» لرفع فشل لأن نسخته المحلية لم تعد موجودة (05c): ملف جديد أصلًا للمادة نفسها، ثم يُزال السجل الفاشل.
    func repick(_ rec: UploadRecord, relativePath: String, filename: String, mimeType: String?) async throws {
        try await enqueue(relativePath: relativePath, materialId: rec.materialId, filename: filename, mimeType: mimeType,
                          lightCopy: .originalOnly, title: rec.materialTitle, priority: rec.materialPriority.flatMap(Priority.init(rawValue:)),
                          owner: rec.ownerAccount ?? scope.current)
        try? await engine.remove(rec.id)
        await refresh()
    }

    /// حذف نسخة أصل بقرار المراسل: لما تحقّق أو طوبق وحده (`LocalCopyPolicy`)، ولو طُلب من مسار لا يفحص.
    func deleteLocalCopy(_ rec: UploadRecord) {
        let current = records.first { $0.id == rec.id } ?? rec
        guard LocalCopyPolicy.mayDelete(record: current) else { return }
        UploadServices.shared.deleteLocalCopy(relativePath: rec.sourcePath)
        localCopies.remove(rec.id)
    }

    func cancel(_ rec: UploadRecord) async { await engine.cancel(rec.id); await refresh() }

    func remove(_ rec: UploadRecord) async {
        try? await engine.remove(rec.id)
        await refresh()
    }

    func pause(_ rec: UploadRecord) async { await engine.pause(rec.id); await refresh() }
    func resume(_ rec: UploadRecord) async { await engine.resume(rec.id); await refresh() }
    func retry(_ rec: UploadRecord) async { _ = try? await engine.retry(rec.id); await refresh() }

    // MARK: المسودات

    /// المسودة لصاحبها: الحساب الداخل حين تُحفظ أول مرة، ولا يتغيّر بعدها (ADR 0113).
    func saveDraft(_ draft: MaterialDraft) {
        var d = draft
        if d.owner == nil { d.owner = allDrafts.first { $0.id == d.id }?.owner ?? scope.current }
        d.updatedAt = Date()
        try? draftStore?.save(d)
        reloadDrafts()
    }

    func deleteDraft(_ id: UUID) {
        draftStore?.delete(id)
        reloadDrafts()
    }

    /// حذف مسودة بقرار المراسل: تُحذف نسخ ملفاتها المحلية أيضًا (لا الأصل في المعرض). لا يُستعمل بعد الإرسال لأن الملفات حينئذ في الطابور.
    func discardDraft(_ draft: MaterialDraft) {
        for file in draft.files { UploadServices.shared.deleteLocalCopy(relativePath: file.relativePath) }
        deleteDraft(draft.id)
    }

    /// يقرأ المسودات من القرص بلا محو: ملف لا يُقرأ (الهاتف مقفل في إطلاق خلفي) يُبقي آخر حالة جيدة في الذاكرة كما في الإرسالات،
    /// والمجلد الذي محاه المسح الطارئ قائمة فارغة.
    func reloadDrafts() {
        if let all = draftStore?.loadAllIfReadable() { allDrafts = all }
        drafts = scope.visible(allDrafts)
    }

    /// الأصل يدخل الطابور فورًا (يُبصم ولا يضيع إن أُنهي التطبيق)، ونسخته الخفيفة تُحضَّر ثم تُرفع قبله. صاحبه الحساب الداخل
    /// (ADR 0093) ما لم يُذكر غيره.
    func enqueue(relativePath: String, materialId: UUID, filename: String, mimeType: String?, lightCopy: ProxyChoice = .originalOnly,
                 title: String? = nil, priority: Priority? = nil, owner: UUID? = nil) async throws {
        let owner = owner ?? scope.current
        try await engine.enqueue(sourcePath: relativePath, materialId: materialId, kind: .original, filename: filename, mimeType: mimeType,
                                 awaitsProxy: lightCopy.preset != nil, materialTitle: title, materialPriority: priority?.rawValue, ownerAccount: owner)
        if let preset = lightCopy.preset, let mode = lightCopy.uploadMode {
            prepareLightCopy(relativePath: relativePath, materialId: materialId, preset: preset, mode: mode, title: title, priority: priority, owner: owner)
        }
        await refresh()
    }

    private func prepareLightCopy(relativePath: String, materialId: UUID, preset: ProxyPreset, mode: UploadSessionCreate.ProxyMode,
                                  title: String?, priority: Priority?, owner: UUID?) {
        let services = UploadServices.shared
        let source = services.documentsDirectory.appendingPathComponent(relativePath)
        let name = LightCopyFiles.newName()
        let output = services.uploadsDirectory.appendingPathComponent(name)
        let transcoder = transcoder
        let engine = engine
        preparingProxy.insert(materialId)
        proxyTasks[materialId] = Task { [weak self] in
            // يستمر التحضير قليلًا بعد الخروج إلى الخلفية؛ إن أُنهي التطبيق يُرفع الأصل وحده عند الإطلاق التالي.
            let background = BackgroundAssertion(name: "light-copy")
            defer { background.end() }
            do {
                _ = try await transcoder.makeProxy(source: source, preset: preset, output: output)
                try Task.checkCancellation()
                try await engine.enqueue(sourcePath: "Uploads/\(name)", materialId: materialId, kind: .proxy, filename: "light-copy.mov",
                                         mimeType: "video/quicktime", proxyMode: mode, materialTitle: title, materialPriority: priority?.rawValue,
                                         ownerAccount: owner)
            } catch {
                try? FileManager.default.removeItem(at: output)
                await engine.releaseProxyHold(materialId: materialId)
            }
            self?.preparingProxy.remove(materialId)
            self?.proxyTasks[materialId] = nil
            await self?.refresh()
        }
    }

    /// تحضير قطعه إنهاء التطبيق يترك نسخة نصف مكتوبة لا يشير إليها سجل؛ الأصل يُرفع وحده (ADR 0075) والملف يُحذف.
    private func removeHalfWrittenLightCopies() {
        let referenced = Set(allRecords.map { URL(fileURLWithPath: $0.sourcePath).lastPathComponent })
        for url in LightCopyFiles.orphans(in: UploadServices.shared.uploadsDirectory, referenced: referenced) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// المسح الطارئ والخروج والإبطال: لا تُضاف نسخة إلى طابور مُسح.
    func cancelLightCopies() {
        proxyTasks.values.forEach { $0.cancel() }
        proxyTasks.removeAll()
        preparingProxy.removeAll()
    }
}

/// شاشة إيصال لمادة، مع سجل الرفع إن وُجد (للعرض دون اتصال)، أو لإرسالة كاملة حين يُعرف `batchId`. `owner` الحساب صاحبه
/// (ADR 0093): لا يُعرض لغيره.
struct ReceiptTarget: Identifiable, Equatable, Sendable {
    let materialId: UUID
    let recordId: UUID?
    var batchId: UUID?
    var owner: UUID?

    init(materialId: UUID, recordId: UUID?, batchId: UUID? = nil, owner: UUID? = nil) {
        self.materialId = materialId
        self.recordId = recordId
        self.batchId = batchId
        self.owner = owner
    }

    var id: UUID { batchId ?? materialId }
}

/// مهلة خلفية من النظام لعمل قصير على الجهاز؛ تُنهى مرة واحدة عند الانتهاء أو عند انقضاء المهلة.
@MainActor
final class BackgroundAssertion {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init(name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

extension UploadPhase {
    /// تحقّق الخادم وأصدر إيصالًا.
    var isVerified: Bool {
        if case .verified = self { return true }
        return false
    }

    var labelKey: LocalizedStringKey {
        switch self {
        case .hashing: return "upload.phase.hashing"
        case .creatingSession, .creatingUpload: return "upload.phase.starting"
        case .transferring: return "upload.phase.transferring"
        case .completing, .awaitingReceipt: return "upload.phase.awaitingReceipt"
        case .verified: return "upload.phase.verified"
        case .deduplicated: return "upload.phase.deduplicated"
        case .failed: return "upload.phase.failed"
        case .cancelled: return "upload.phase.cancelled"
        }
    }
}

extension UploadFailure {
    /// مفتاح النص في `Localizable.xcstrings` (`textKey` في MaterialsCore، مختبر بالعربية والإنجليزية).
    var labelKey: LocalizedStringKey { LocalizedStringKey(textKey) }
}

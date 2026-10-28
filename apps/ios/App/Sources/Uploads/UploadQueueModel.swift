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
    @Published private(set) var records: [UploadRecord] = []
    @Published private(set) var localCopies: Set<UUID> = []
    /// أصول تنتظر نسخة خفيفة في الطابور، ومواد تُحضَّر نسختها الآن (ADR 0075).
    @Published private(set) var waitingForProxy: Set<UUID> = []
    @Published private(set) var preparingProxy: Set<UUID> = []
    /// الشبكة كما تراها بطاقة الرفع (المواصفة A2): بلا شبكة، أو بانتظار Wi‑Fi حين يكون «Wi‑Fi فقط» مفعّلًا.
    enum NetworkState: Equatable { case online, offline, waitingForWifi }
    @Published private(set) var networkState: NetworkState = .online
    /// الزمن المتبقي التقديري لكل سجل من سرعة آخر 30 ثانية؛ يغيب بلا عيّنات كافية أو بلا شبكة.
    @Published private(set) var etaSeconds: [UUID: TimeInterval] = [:]
    /// مسودات «مادة جديدة» المحفوظة على الجهاز (تظهر أعلى شاشة الرفع).
    @Published private(set) var drafts: [MaterialDraft] = []
    /// إيصال وصل للتو: يُعرض شاشة الإيصال تلقائيًا (A3).
    @Published var presentedReceipt: ReceiptTarget?
    let engine: UploadEngine
    let settings: AppSettings
    let draftStore: FileDraftStore?
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
        drafts = draftStore?.loadAll() ?? []
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
        if !lastPath.satisfied { networkState = .offline }
        else if settings.uploadOverWifiOnly, lastPath.expensive || lastPath.constrained { networkState = .waitingForWifi }
        else { networkState = .online }
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
                }
                await refresh()
            }
        }
    }

    func refresh() async {
        records = await engine.allRecords()
        waitingForProxy = await engine.waitingForProxy()
        localCopies = Set(records.filter { UploadServices.shared.localCopyExists(relativePath: $0.sourcePath) }.map(\.id))
    }

    private func receiptArrived(_ id: UUID) async {
        guard let rec = await engine.record(id) else { return }
        if rec.kind == .original { presentedReceipt = ReceiptTarget(materialId: rec.materialId, recordId: rec.id) }
        // النسخة الخفيفة مشتقة يصنعها التطبيق: تُحذف دائمًا بعد إيصالها. الأصل قرار المراسل.
        guard rec.kind == .proxy || settings.deleteLocalAfterReceipt else { return }
        UploadServices.shared.deleteLocalCopy(relativePath: rec.sourcePath)
    }

    func deleteLocalCopy(_ rec: UploadRecord) {
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

    func saveDraft(_ draft: MaterialDraft) {
        var d = draft
        d.updatedAt = Date()
        try? draftStore?.save(d)
        drafts = draftStore?.loadAll() ?? []
    }

    func deleteDraft(_ id: UUID) {
        draftStore?.delete(id)
        drafts = draftStore?.loadAll() ?? []
    }

    /// حذف مسودة بقرار المراسل: تُحذف نسخ ملفاتها المحلية أيضًا (لا الأصل في المعرض). لا يُستعمل بعد الإرسال لأن الملفات حينئذ في الطابور.
    func discardDraft(_ draft: MaterialDraft) {
        for file in draft.files { UploadServices.shared.deleteLocalCopy(relativePath: file.relativePath) }
        deleteDraft(draft.id)
    }

    /// بعد المسح الطارئ: المجلد مُحي، والقائمة تُفرغ.
    func reloadDrafts() { drafts = draftStore?.loadAll() ?? [] }

    /// الأصل يدخل الطابور فورًا (يُبصم ولا يضيع إن أُنهي التطبيق)، ونسخته الخفيفة تُحضَّر ثم تُرفع قبله.
    func enqueue(relativePath: String, materialId: UUID, filename: String, mimeType: String?, lightCopy: ProxyChoice = .originalOnly,
                 title: String? = nil, priority: Priority? = nil) async throws {
        try await engine.enqueue(sourcePath: relativePath, materialId: materialId, kind: .original, filename: filename, mimeType: mimeType,
                                 awaitsProxy: lightCopy.preset != nil, materialTitle: title, materialPriority: priority?.rawValue)
        if let preset = lightCopy.preset, let mode = lightCopy.uploadMode {
            prepareLightCopy(relativePath: relativePath, materialId: materialId, preset: preset, mode: mode, title: title, priority: priority)
        }
        await refresh()
    }

    private func prepareLightCopy(relativePath: String, materialId: UUID, preset: ProxyPreset, mode: UploadSessionCreate.ProxyMode,
                                  title: String?, priority: Priority?) {
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
                                         mimeType: "video/quicktime", proxyMode: mode, materialTitle: title, materialPriority: priority?.rawValue)
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
        let referenced = Set(records.map { URL(fileURLWithPath: $0.sourcePath).lastPathComponent })
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

/// شاشة إيصال لمادة، مع سجل الرفع إن وُجد (للعرض دون اتصال).
struct ReceiptTarget: Identifiable, Equatable {
    let materialId: UUID
    let recordId: UUID?
    var id: UUID { materialId }
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
    /// مفتاح النص في `Localizable.xcstrings`.
    var textKey: String {
        switch self {
        case .checksumMismatch: return "upload.failure.checksumMismatch"
        case .invalidFile: return "upload.failure.invalidFile"
        case .expired: return "upload.failure.expired"
        case .aborted: return "upload.failure.aborted"
        case .storageError: return "upload.failure.storageError"
        case .sourceMissing: return "upload.failure.sourceMissing"
        case .rejected: return "upload.failure.rejected"
        case .deviceNotAttested: return "upload.failure.deviceNotAttested"
        }
    }

    var labelKey: LocalizedStringKey { LocalizedStringKey(textKey) }
}

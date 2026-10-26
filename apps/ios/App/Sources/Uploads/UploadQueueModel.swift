import Foundation
import MediaCore
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
    let engine: UploadEngine
    let settings: AppSettings
    private let transcoder: any ProxyTranscoder = AVFoundationProxyTranscoder()
    private var proxyTasks: [UUID: Task<Void, Never>] = [:]
    private var watcher: Task<Void, Never>?

    init(engine: UploadEngine, settings: AppSettings) {
        self.engine = engine
        self.settings = settings
    }

    func start() {
        watcher?.cancel()
        watcher = Task { [weak self] in
            guard let self else { return }
            let stream = await engine.events()
            await engine.resumeAll()
            await refresh()
            removeHalfWrittenLightCopies()
            for await event in stream {
                if case .phaseChanged(let id, let phase) = event {
                    SafeLog.phase(id, phase)
                    if case .verified = phase { await receiptArrived(id) }
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

    /// الأصل يدخل الطابور فورًا (يُبصم ولا يضيع إن أُنهي التطبيق)، ونسخته الخفيفة تُحضَّر ثم تُرفع قبله.
    func enqueue(relativePath: String, materialId: UUID, filename: String, mimeType: String?, lightCopy: ProxyChoice = .originalOnly) async throws {
        try await engine.enqueue(sourcePath: relativePath, materialId: materialId, kind: .original, filename: filename, mimeType: mimeType,
                                 awaitsProxy: lightCopy.preset != nil)
        if let preset = lightCopy.preset, let mode = lightCopy.uploadMode {
            prepareLightCopy(relativePath: relativePath, materialId: materialId, preset: preset, mode: mode)
        }
        await refresh()
    }

    private func prepareLightCopy(relativePath: String, materialId: UUID, preset: ProxyPreset, mode: UploadSessionCreate.ProxyMode) {
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
                                         mimeType: "video/quicktime", proxyMode: mode)
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
    var labelKey: LocalizedStringKey {
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
}

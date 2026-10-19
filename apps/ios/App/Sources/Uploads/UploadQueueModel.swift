import Foundation
import PostHistoryAPI
import SwiftUI
import UploadCore

/// طابور الرفع كما تراه الواجهة؛ يراقب أحداث النواة ويطبّق قرار الحذف المحلي.
@MainActor
final class UploadQueueModel: ObservableObject {
    @Published private(set) var records: [UploadRecord] = []
    @Published private(set) var localCopies: Set<UUID> = []
    let engine: UploadEngine
    let settings: AppSettings
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
        localCopies = Set(records.filter { UploadServices.shared.localCopyExists(relativePath: $0.sourcePath) }.map(\.id))
    }

    private func receiptArrived(_ id: UUID) async {
        guard settings.deleteLocalAfterReceipt, let rec = await engine.record(id) else { return }
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

    func enqueue(relativePath: String, materialId: UUID, filename: String, mimeType: String?) async throws {
        try await engine.enqueue(sourcePath: relativePath, materialId: materialId, kind: .original, filename: filename, mimeType: mimeType)
        await refresh()
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
        }
    }
}

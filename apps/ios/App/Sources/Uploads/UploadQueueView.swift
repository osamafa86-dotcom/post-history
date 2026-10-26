import PostHistoryAPI
import SwiftUI
import UploadCore

struct UploadQueueView: View {
    @EnvironmentObject private var queue: UploadQueueModel

    var body: some View {
        if queue.records.isEmpty {
            Text("home.uploads.empty").foregroundStyle(.secondary)
        }
        ForEach(queue.records) { rec in
            UploadRow(record: rec, hasLocalCopy: queue.localCopies.contains(rec.id))
        }
    }
}

struct UploadRow: View {
    @EnvironmentObject private var queue: UploadQueueModel
    let record: UploadRecord
    let hasLocalCopy: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if record.kind == .proxy {
                Label("upload.kind.proxy", systemImage: "bolt.horizontal.fill").font(.headline)
            } else {
                Text(record.filename).font(.headline).lineLimit(1)
            }
            switch record.phase {
            case .transferring:
                ProgressView(value: record.fractionTransferred)
                Text("upload.phase.transferring").font(.caption).foregroundStyle(.secondary)
                Text("upload.resumeNote").font(.caption2).foregroundStyle(.secondary)
            case .verified(let receipt):
                Label { Text("upload.receipt \(receipt)") } icon: { Image(systemName: "checkmark.seal.fill").foregroundStyle(.green) }
                    .font(.subheadline.weight(.semibold))
                if hasLocalCopy {
                    // تذكير بارز: النسخة المحلية ما زالت على الهاتف؛ حذفها قرار المراسل.
                    Label("upload.localCopy.reminder", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(.orange)
                    Button("upload.localCopy.delete", role: .destructive) { queue.deleteLocalCopy(record) }.font(.caption)
                }
            case .failed(let failure):
                Label { Text(failure.labelKey) } icon: { Image(systemName: "xmark.octagon.fill").foregroundStyle(.red) }.font(.subheadline)
            default:
                if queue.preparingProxy.contains(record.materialId), record.kind == .original {
                    Label("upload.preparingProxy", systemImage: "wand.and.rays").font(.caption).foregroundStyle(.secondary)
                } else if queue.waitingForProxy.contains(record.id) {
                    Label("upload.waitingForProxy", systemImage: "hourglass").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(record.phase.labelKey).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .swipeActions {
            if record.phase.isTerminal {
                Button("upload.remove", role: .destructive) { Task { await queue.remove(record) } }
            } else {
                Button("upload.cancel", role: .destructive) { Task { await queue.cancel(record) } }
            }
        }
    }
}

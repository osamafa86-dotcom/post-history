import MaterialsCore
import PhotosUI
import PostHistoryAPI
import SwiftUI
import UploadCore

/// 05 · الرفع (docs/design/specs/reporter-v2.md «الرفع»): دوائر البثّ بنسبة ما وصل من آخر إرسالة، وتحتها كل ملف بمرحلته.
/// الانقطاع لا يحتاج فعلًا من المراسل (05b)، والفشل النهائي يقول السبب بكلماته وخطوتين (05c). لا إجراء مدمّر بالسحب:
/// الإلغاء زرّ بتأكيد (ADR 0081)، والإزالة زرّ بتأكيد.
struct UploadsScreen: View {
    @EnvironmentObject private var queue: UploadQueueModel

    @State private var cancelTarget: UploadRecord?
    @State private var removeTarget: UploadRecord?
    @State private var repickTarget: UploadRecord?
    @State private var repickItem: PhotosPickerItem?
    @State private var repickError = false

    private var shown: [UploadRecord] { queue.uploadScreenRecords }
    private var items: [UploadItem] { shown.map { queue.item($0) } }
    private var online: Bool { queue.networkState == .online }
    private var ringState: UploadOverview.RingState { UploadOverview.ringState(items, online: online) }
    private var fraction: Double { UploadOverview.fraction(items) }
    private var firstFailure: (record: UploadRecord, failure: UploadFailure)? {
        for rec in shown { if case .failed(let f) = rec.phase { return (rec, f) } }
        return nil
    }

    var body: some View {
        ScrollView {
            VStack(spacing: VL.Space.s5) {
                if shown.isEmpty {
                    VLEmptyState(title: "uploads.empty.title", message: "uploads.empty.body")
                } else {
                    rings
                    note
                    ForEach(shown, id: \.id) { rec in row(rec) }
                    Text("upload.background").vlText(.caption).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
                }
            }
            .padding(VL.Space.s5)
        }
        .vlScreen()
        .navigationTitle("uploads.title")
        .navigationBarTitleDisplayMode(.inline)
        .modifier(CancelUploadConfirmation(isPresented: Binding(get: { cancelTarget != nil }, set: { if !$0 { cancelTarget = nil } })) {
            if let rec = cancelTarget { Task { await queue.cancel(rec) } }
        })
        .confirmationDialog("upload.remove.confirm.title", isPresented: Binding(get: { removeTarget != nil }, set: { if !$0 { removeTarget = nil } }),
                            titleVisibility: .visible, presenting: removeTarget) { rec in
            Button("upload.remove", role: .destructive) { Task { await queue.remove(rec) } }
            Button("material.cancel", role: .cancel) {}
        } message: { _ in
            Text("upload.remove.confirm.message")
        }
        .photosPicker(isPresented: Binding(get: { repickTarget != nil && repickItem == nil }, set: { if !$0, repickItem == nil { repickTarget = nil } }),
                      selection: $repickItem, matching: .any(of: [.videos, .images]), preferredItemEncoding: .current)
        .onChange(of: repickItem) { _, item in
            guard let item, let target = repickTarget else { return }
            Task { await repick(target, item) }
        }
        .alert("material.error.import", isPresented: $repickError) { Button("receipt.done", role: .cancel) {} }
    }

    // MARK: الدوائر والملاحظة

    private var rings: some View {
        VStack(spacing: VL.Space.s3) {
            ZStack {
                BroadcastRings(state: ringsState, fraction: fraction, diameter: 220)
                // عند الوصول تمتلئ الدائرة بعلامة ✓ وتنتقل الكلمة تحتها.
                if ringState != .done {
                    VStack(spacing: VL.Space.s1) {
                        Text(verbatim: VLFormat.percent(fraction))
                            .vlText(.bigNumber)
                            .foregroundStyle(Color.vl.textPrimary)
                            .environment(\.layoutDirection, .leftToRight)
                        ringLabel
                    }
                    .frame(maxWidth: 220 * 0.42)
                    .minimumScaleFactor(0.6)
                }
            }
            if ringState == .done { ringLabel }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("uploads.rings.a11y \(VLFormat.percent(fraction)) \(Text(ringWord))"))
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var ringLabel: some View {
        Label { Text(ringWord).vlText(.label) } icon: { if let icon = ringIcon { Image(systemName: icon) } }
            .labelStyle(VLCompactLabelStyle())
            .foregroundStyle(ringTone)
            .multilineTextAlignment(.center)
    }

    private var ringsState: BroadcastRings.State {
        switch ringState {
        case .uploading: return .uploading
        case .waiting: return .waiting
        case .done: return .done
        case .failed: return .failed
        }
    }

    private var ringWord: LocalizedStringKey {
        switch ringState {
        case .uploading: return "upload.ring.uploading"
        case .waiting: return online ? "upload.paused" : (queue.networkState == .waitingForWifi ? "upload.waitingForWifi" : "upload.waitingForNetwork")
        case .done: return "upload.ring.done"
        case .failed: return "upload.ring.failed"
        }
    }

    private var ringIcon: String? {
        switch ringState {
        case .uploading: return nil
        case .waiting: return online ? "pause" : "wifi.slash"
        case .done: return "checkmark"
        case .failed: return "exclamationmark.triangle"
        }
    }

    private var ringTone: Color {
        switch ringState {
        case .uploading: return .vl.textSecondary
        case .waiting: return .vl.stateWarn
        case .done: return .vl.stateOk
        case .failed: return .vl.stateDanger
        }
    }

    /// ثلاثة أشياء دائمًا: أين وصلنا، وأن الانقطاع آمن، وما الخطوة التالية (design-brief.md §5.2).
    @ViewBuilder private var note: some View {
        if let failed = firstFailure {
            VLNote(tone: .danger, systemImage: "exclamationmark.triangle",
                   text: Text("upload.note.failed \(failed.record.materialTitle ?? failed.record.filename) \(Text(LocalizedStringKey(failed.failure.textKey)))"))
        } else if !online, ringState != .done {
            VLNote(tone: .warn, systemImage: "wifi.slash", text: Text("upload.offline"))
        } else if ringState == .done {
            VLNote(tone: .ok, systemImage: "checkmark", text: Text("upload.note.done"))
        } else if UploadOverview.previewCount(items) > 0 {
            VLNote(tone: .ok, systemImage: "checkmark", text: Text("upload.light.arrived"))
        } else {
            VLNote(tone: .brand, systemImage: "shield", text: Text("upload.reassurance"))
        }
    }

    // MARK: الصفوف

    private func row(_ rec: UploadRecord) -> some View {
        let item = queue.item(rec)
        return UploadRow(title: rec.materialTitle ?? rec.filename, thumbnailPath: queue.localCopies.contains(rec.id) ? rec.sourcePath : nil,
                         isVideo: rec.mimeType?.hasPrefix("video") ?? false, item: item,
                         status: UploadRowStatus.make(item, network: queue.networkState)) {
            actions(rec, item)
        }
    }

    @ViewBuilder private func actions(_ rec: UploadRecord, _ item: UploadItem) -> some View {
        switch rec.phase {
        case .failed(let failure):
            HStack(spacing: VL.Space.s3) {
                if failure == .sourceMissing {
                    Button("upload.repick") { repickTarget = rec }.buttonStyle(VLButtonStyle(kind: .solid, size: .small))
                } else {
                    Button("upload.retry") { Task { await queue.retry(rec) } }.buttonStyle(VLButtonStyle(kind: .solid, size: .small))
                }
                Button("upload.removeShort") { removeTarget = rec }.buttonStyle(VLButtonStyle(kind: .outline, size: .small))
            }
        case .verified, .deduplicated, .cancelled:
            EmptyView()
        default:
            HStack(spacing: VL.Space.s2) {
                Button {
                    Task { if item.paused { await queue.resume(rec) } else { await queue.pause(rec) } }
                } label: {
                    Label(LocalizedStringKey(item.paused ? "upload.resume" : "upload.pause"), systemImage: item.paused ? "play" : "pause")
                }
                .buttonStyle(.vlGhost)
                Spacer(minLength: 0)
                // إلغاء صريح بتأكيد؛ لا يُلغى الرفع بسحب ولا بلمسة واحدة (ADR 0081).
                Button(role: .destructive) { cancelTarget = rec } label: { Label("upload.cancel", systemImage: "xmark.circle") }
                    .buttonStyle(.vlGhost)
            }
        }
    }

    private func repick(_ rec: UploadRecord, _ item: PhotosPickerItem) async {
        defer { repickItem = nil; repickTarget = nil }
        guard let picked = try? await item.loadTransferable(type: PickedFile.self) else { repickError = true; return }
        defer { try? FileManager.default.removeItem(at: picked.url) }
        do {
            let file = try await FileImport.importFile(picked.url)
            try await queue.repick(rec, relativePath: file.relativePath, filename: file.filename, mimeType: file.mimeType)
        } catch {
            repickError = true
        }
    }
}

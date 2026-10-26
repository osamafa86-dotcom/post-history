import CoreImage.CIFilterBuiltins
import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UIKit
import UploadCore

/// A3 · الإيصال (docs/design/specs/reporter.md): حدث احتفالي، وبطاقة إيصال قابلة للمشاركة داخل المؤسسة، وقرار النسخة المحلية.
/// البطاقة لا تحمل موقعًا ولا أسماء مصادر ولا معرّف جهاز؛ رمز QR يشفّر معرّف المادة وحده.
struct ReceiptScreen: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var queue: UploadQueueModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale

    let target: ReceiptTarget
    @State private var material: PostHistoryAPI.Material?
    @State private var appeared = false
    @State private var confirmDelete = false
    @State private var copied = false

    private var record: UploadRecord? { target.recordId.flatMap { id in queue.records.first { $0.id == id } } }

    private var details: ReceiptDetails? { ReceiptDetails(material: material, record: record) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: VL.Space.s7) {
                    if let details {
                        hero(details)
                        ReceiptCard(details: details)
                        shareActions(details)
                        localCopyCard
                    } else {
                        ProgressView().padding(VL.Space.s10)
                    }
                }
                .padding(VL.Space.s5)
            }
            .vlScreen()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("receipt.done") { dismiss() } } }
            .task { await load() }
            .sensoryFeedback(.success, trigger: appeared) { _, new in new && details?.deduplicated == false }
            .confirmationDialog("receipt.localCopy.confirm", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("upload.localCopy.delete", role: .destructive) { deleteLocalCopy() }
                Button("receipt.localCopy.keep", role: .cancel) {}
            }
        }
    }

    private func hero(_ d: ReceiptDetails) -> some View {
        VStack(spacing: VL.Space.s4) {
            ZStack {
                Circle().fill(d.deduplicated ? Color.vl.toneNeutralBg : Color.vl.toneGoodBg)
                Circle().strokeBorder(d.deduplicated ? Color.vl.toneNeutralBorder : Color.vl.toneGoodBorder, lineWidth: VL.Border.regular)
                Image(systemName: d.deduplicated ? "doc.text" : "checkmark")
                    .font(.system(size: VL.Space.s9, weight: .semibold))
                    .foregroundStyle(d.deduplicated ? Color.vl.toneNeutralFg : Color.vl.toneGoodFg)
            }
            .frame(width: VL.Space.s12 + VL.Space.s3, height: VL.Space.s12 + VL.Space.s3)
            .scaleEffect(appeared || reduceMotion || d.deduplicated ? 1 : 0.9)
            .opacity(appeared || reduceMotion ? 1 : 0)
            .accessibilityHidden(true)
            Text(LocalizedStringKey(d.deduplicated ? "receipt.duplicate.title" : "receipt.title"))
                .vlText(.headingH2).foregroundStyle(Color.vl.textPrimary).multilineTextAlignment(.center)
            Text(LocalizedStringKey(d.deduplicated ? "receipt.duplicate.body" : "receipt.body"))
                .vlText(.bodyMd).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
        }
        .onAppear {
            withAnimation(reduceMotion ? nil : VL.Easing.emphasized(VL.Duration.slow)) { appeared = true }
        }
    }

    @ViewBuilder private func shareActions(_ d: ReceiptDetails) -> some View {
        if !d.receiptNumber.isEmpty { shareButtons(d) }
    }

    private func shareButtons(_ d: ReceiptDetails) -> some View {
        VStack(spacing: VL.Space.s3) {
            if let image = renderShareImage(d) {
                ShareLink(item: image, preview: SharePreview(Text("receipt.share.preview \(d.receiptNumber)"), image: image)) {
                    Label("receipt.share", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.vlSecondary)
            }
            Button {
                UIPasteboard.general.string = d.receiptNumber
                copied = true
            } label: { Label(LocalizedStringKey(copied ? "receipt.copied" : "receipt.copy"), systemImage: copied ? "checkmark" : "doc.on.doc") }
                .buttonStyle(.vlGhost)
        }
    }

    /// صورة PNG للبطاقة بمقاس 1080×1350 للمشاركة داخل المؤسسة عبر ورقة مشاركة النظام.
    @MainActor private func renderShareImage(_ d: ReceiptDetails) -> Image? {
        let renderer = ImageRenderer(content:
            ReceiptCard(details: d)
                .padding(VL.Space.s7)
                .frame(width: 1080 / 3, height: 1350 / 3)
                .background(Color.vl.bgCanvas)
                .environment(\.locale, Locale.current)
        )
        renderer.scale = 3
        guard let ui = renderer.uiImage else { return nil }
        return Image(uiImage: ui)
    }

    @ViewBuilder private var localCopyCard: some View {
        if let record, queue.localCopies.contains(record.id), !settings.localCopyHandled.contains(target.materialId) {
            VLCard(border: Color.vl.toneAttentionBorder, background: Color.vl.toneAttentionBg) {
                Text("receipt.localCopy.title").vlText(.labelLg).foregroundStyle(Color.vl.toneAttentionFg)
                Text("receipt.localCopy.body").vlText(.bodySm).foregroundStyle(Color.vl.textPrimary)
                Button { confirmDelete = true } label: { Label("upload.localCopy.delete", systemImage: "lock.fill") }.buttonStyle(.vlPrimary)
                Button("receipt.localCopy.keep") { settings.markLocalCopyHandled(target.materialId) }.buttonStyle(.vlGhost)
            }
        }
    }

    private func deleteLocalCopy() {
        if let record { queue.deleteLocalCopy(record) }
        settings.markLocalCopyHandled(target.materialId)
    }

    /// المادة من الخادم (العنوان واطّلاع المشرف وإيصال الأصل)؛ بلا شبكة يكفي سجل الرفع المحلي.
    private func load() async {
        material = try? await MaterialsAPI.getMaterial(id: target.materialId, apiConfiguration: app.api)
    }
}

/// ما تعرضه بطاقة الإيصال، من المادة إن وصلت أو من سجل الرفع المحلي.
struct ReceiptDetails: Equatable {
    var receiptNumber: String
    var title: String?
    var receivedAt: Date?
    var sizeBytes: Int64?
    var sha256: String?
    var acknowledgedAt: Date?
    var materialId: UUID
    var deduplicated: Bool

    init?(material: PostHistoryAPI.Material?, record: UploadRecord?) {
        let file = material?.originalFile
        var receipt = file?.receiptNumber
        var dedup = false
        if let record {
            switch record.phase {
            case .verified(let number): receipt = receipt ?? number
            case .deduplicated: dedup = true
            default: break
            }
        }
        // المكرّرة قد لا تحمل رقمًا معروفًا هنا (الأصل في مادة أخرى)؛ تُعرض بلا رقم ولا مشاركة.
        guard let materialId = material?.id ?? record?.materialId, dedup || !(receipt ?? "").isEmpty else { return nil }
        receiptNumber = receipt ?? ""
        title = material?.title ?? record?.materialTitle
        receivedAt = file?.verifiedAt ?? record?.updatedAt
        sizeBytes = file?.sizeBytes.map(Int64.init) ?? record?.sizeBytes
        sha256 = file?.sha256 ?? record?.sha256Hex
        acknowledgedAt = material?.acknowledgedAt
        self.materialId = materialId
        deduplicated = dedup
    }
}

/// بطاقة الإيصال: الرقم بخط أحادي قابل للتحديد، والتفاصيل بلا موقع ولا أسماء، ورمز QR بمعرّف المادة.
struct ReceiptCard: View {
    let details: ReceiptDetails

    var body: some View {
        VLCard(border: .vl.borderStrong, background: .vl.bgSurfaceRaised) {
            Label { VLOverline("receipt.card.title") } icon: { Image(systemName: "doc.text").foregroundStyle(Color.vl.iconMuted) }
            if !details.receiptNumber.isEmpty {
                Text(verbatim: details.receiptNumber)
                    .vlText(.monoLg).foregroundStyle(Color.vl.textPrimary)
                    .textSelection(.enabled)
                    .environment(\.layoutDirection, .leftToRight)
                    .accessibilityLabel(Text("upload.receipt \(details.receiptNumber)"))
            }
            VStack(alignment: .leading, spacing: VL.Space.s3) {
                if let title = details.title { row("receipt.row.material") { Text(verbatim: title).vlText(.bodySm) } }
                if let at = details.receivedAt {
                    row("receipt.row.receivedAt") { Text(at.formatted(date: .abbreviated, time: .shortened)).vlText(.bodySm) }
                }
                if let size = details.sizeBytes {
                    row("receipt.row.size") {
                        VStack(alignment: .leading, spacing: VL.Space.s1) {
                            Text(verbatim: ByteCountFormatter.string(fromByteCount: size, countStyle: .file)).vlText(.bodySm)
                            if let sha = details.sha256 {
                                Text(verbatim: "SHA-256 " + ReceiptFormatting.shortHash(sha))
                                    .vlText(.monoMd).foregroundStyle(Color.vl.textSecondary).environment(\.layoutDirection, .leftToRight)
                            }
                        }
                    }
                }
                row("receipt.row.supervisor") {
                    if let ack = details.acknowledgedAt {
                        Label { Text("receipt.acknowledged \(ack.formatted(date: .omitted, time: .shortened))") } icon: {
                            Image(systemName: "checkmark").foregroundStyle(Color.vl.toneGoodFg)
                        }.vlText(.bodySm)
                    } else {
                        Text("receipt.notYetAcknowledged").vlText(.bodySm).foregroundStyle(Color.vl.textSecondary)
                    }
                }
            }
            HStack(alignment: .center, spacing: VL.Space.s4) {
                QRCode(text: ReceiptFormatting.internalLink(materialId: details.materialId))
                    .frame(width: VL.Space.s12 + VL.Space.s5, height: VL.Space.s12 + VL.Space.s5)
                    .accessibilityLabel(Text("receipt.qr"))
                Text("receipt.qr.caption").vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
            }
        }
    }

    private func row<Value: View>(_ key: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: VL.Space.s4) {
            Text(LocalizedStringKey(key)).vlText(.labelMd).foregroundStyle(Color.vl.textSecondary)
                .frame(minWidth: VL.Size.thumbH, alignment: .leading)
            value().foregroundStyle(Color.vl.textPrimary)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// رمز QR محلي (CoreImage) بلا شبكة.
struct QRCode: View {
    let text: String

    var body: some View {
        if let image = Self.make(text) {
            Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
        }
    }

    static func make(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

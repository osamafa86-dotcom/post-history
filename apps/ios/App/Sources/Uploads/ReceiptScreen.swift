import CoreImage.CIFilterBuiltins
import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UIKit
import UploadCore

/// 06 · الإيصال الاحتفالي (docs/design/specs/reporter-v2.md «الإيصال»): دوائر تمتلئ، و«وصلت المواد»، ورقم الإيصال والوقت والحجم
/// والبصمة (أرقام LTR)، وخيار حذف النسخ المحلية (غير مفعّل افتراضيًا، يُطبَّق لحظة وضع العلامة)، وإجراءان «إرسال آخر» و«موادي».
/// إرسالة بعدة ملفات لها إيصال واحد حين يصل آخرها (ADR 0088)؛ ومادة بلا إرسالة («لقطة بديلة») لها إيصالها كما كان.
/// لا اسم مصدر ولا موقع؛ رمز QR يشفّر معرّف المادة وحده، والصورة المشاركة تحمل الرقم والوقت وحدهما (ADR 0076).
struct ReceiptScreen: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var queue: UploadQueueModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let target: ReceiptTarget
    var onSendAnother: () -> Void = {}
    var onMyMaterials: () -> Void = {}

    @State private var material: PostHistoryAPI.Material?
    /// حُذفت النسخ المحلية من هذا الإيصال (لا رجعة فيه، فالعلامة لا تُرفع بعده).
    @State private var deletedLocal = false
    @State private var copied = false
    @State private var showAllNumbers = false
    @State private var appeared = false

    private var batch: SendBatch? { target.batchId.flatMap { id in queue.batches.first { $0.id == id } } }
    private var record: UploadRecord? { target.recordId.flatMap { id in queue.records.first { $0.id == id } } }

    /// سجلات الإيصال: أصول الإرسالة الواصلة، أو سجل المادة الواحدة.
    private var scope: [UploadRecord] {
        if let batch { return queue.originals(of: batch).filter { queue.item($0).state == .arrived } }
        return record.map { [$0] } ?? []
    }

    private var details: ReceiptDetails? { batch == nil ? ReceiptDetails(material: material, record: record) : nil }
    private var receiptNumbers: [String] {
        if batch != nil {
            return scope.compactMap { rec -> String? in
                if case .verified(let n) = rec.phase { return n }
                return nil
            }
        }
        return details.map { $0.receiptNumber.isEmpty ? [] : [$0.receiptNumber] } ?? []
    }
    private var deduplicated: Bool { batch == nil && details?.deduplicated == true }
    private var count: Int { max(scope.count, 1) }
    private var title: String { batch?.title ?? details?.title ?? "" }
    /// خيار الحذف بقاعدة `LocalCopyPolicy` الواحدة للنطاقين: يُعرض لما تحقّق أو طوبق وحده (الخطة: بعد «وصل الأصل وتم التحقق منه»)،
    /// وما زال في طريقه إلى التحقق يُقال إن حذفه بعده. «عرض الإيصال» من «موادي» قد يفتح المادة قبل التحقق (`original_received`).
    private var localCopyChoice: LocalCopyPolicy.ReceiptChoice {
        LocalCopyPolicy.receiptChoice(scope: scope) { queue.localCopies.contains($0.id) && !settings.localCopyHandled.contains($0.materialId) }
    }
    private var withLocalCopy: [UploadRecord] { localCopyChoice.deletable }

    var body: some View {
        ScrollView {
            VStack(spacing: VL.Space.s5) {
                HStack {
                    Spacer()
                    VLIconButton(systemImage: "xmark", label: "receipt.done") { dismiss() }
                }
                BroadcastRings(state: .done, diameter: 176)
                headline
                if !withLocalCopy.isEmpty || deletedLocal {
                    Toggle(isOn: Binding(get: { deletedLocal }, set: { if $0 { deleteLocalCopies() } })) {
                        VStack(alignment: .leading, spacing: VL.Space.s1) {
                            Text("receipt.deleteLocal").vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                            Text(LocalizedStringKey(deletedLocal ? "receipt.deleteLocal.done" : "receipt.deleteLocal.hint"))
                                .vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                        }
                    }
                    .toggleStyle(VLCheckboxStyle())
                    .disabled(deletedLocal)
                } else if !localCopyChoice.awaitingVerification.isEmpty {
                    VLNote(tone: .muted, systemImage: "clock", text: Text("receipt.deleteLocal.afterVerification"))
                }
                if !deduplicated { slip }
                if let details, !deduplicated { singleExtras(details) }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: VL.Space.s3) { actionButtons }
                    VStack(spacing: VL.Space.s3) { actionButtons }
                }
            }
            .padding(VL.Space.s5)
        }
        .vlScreen()
        .sensoryFeedback(.success, trigger: appeared) { _, new in new && !deduplicated }
        .onAppear { appeared = true }
        .task { await load() }
    }

    private var headline: some View {
        VStack(spacing: VL.Space.s3) {
            Text(LocalizedStringKey(deduplicated ? "receipt.duplicate.title" : (count > 1 ? "receipt.v2.title" : "receipt.v2.titleOne")))
                .vlText(.display)
                .foregroundStyle(Color.vl.textPrimary)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Group {
                if deduplicated {
                    Text("receipt.duplicate.body")
                } else if count > 1 {
                    Text("receipt.v2.body \(Text("receipt.items \(count)")) \(title)")
                } else {
                    Text("receipt.v2.bodyOne \(title)")
                }
            }
            .vlText(.body)
            .foregroundStyle(Color.vl.textSecondary)
            .multilineTextAlignment(.center)
        }
    }

    private var slip: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            ReceiptSlip(rows: slipRows)
            if receiptNumbers.count > 1 {
                Button { VLMotion.animate(reduceMotion) { showAllNumbers.toggle() } } label: {
                    if showAllNumbers { Text("receipt.numbers.hide") } else { Text("receipt.numbers.show \(receiptNumbers.count)") }
                }
                .buttonStyle(.vlGhost)
                if showAllNumbers {
                    ReceiptSlip(rows: receiptNumbers.map { n -> ReceiptSlip.Row in
                        ReceiptSlip.Row(label: "receipt.row.number", value: n, mono: true, a11yValue: Text("upload.receipt \(n)"))
                    })
                }
            }
        }
    }

    private var slipRows: [ReceiptSlip.Row] {
        var rows: [ReceiptSlip.Row] = []
        if let first = receiptNumbers.first {
            rows.append(.init(label: "receipt.row.number", value: first, mono: true, a11yValue: Text("upload.receipt \(first)")))
        }
        let received: Date? = batch != nil ? scope.map(\.updatedAt).max() : (details?.receivedAt ?? record?.updatedAt)
        if let received { rows.append(.init(label: "receipt.row.time", value: VLFormat.time(received))) }
        let size: Int64? = batch != nil ? scope.reduce(Int64(0), { $0 + $1.sizeBytes }) : details?.sizeBytes
        if let size { rows.append(.init(label: "receipt.row.size", value: VLFormat.bytes(size))) }
        if count == 1, let sha = details?.sha256 ?? scope.first?.sha256Hex {
            let short = ReceiptFormatting.shortHash(sha)
            rows.append(.init(label: "receipt.row.fingerprint", value: short, mono: true, a11yValue: Text("receipt.fingerprint.a11y \(short)")))
        }
        return rows
    }

    /// للمادة الواحدة كما كان: اطّلاع المشرف، ورمز QR داخلي، ومشاركة الرقم ونسخه.
    @ViewBuilder private func singleExtras(_ d: ReceiptDetails) -> some View {
        VLCard {
            HStack(alignment: .firstTextBaseline) {
                Text("receipt.row.supervisor").vlText(.label).foregroundStyle(Color.vl.textSecondary)
                Spacer(minLength: VL.Space.s3)
                if let ack = d.acknowledgedAt {
                    Label { Text("receipt.acknowledged \(VLFormat.time(ack))") } icon: { Image(systemName: "checkmark") }
                        .labelStyle(VLCompactLabelStyle())
                        .vlText(.label).foregroundStyle(Color.vl.stateOk)
                } else {
                    Text("receipt.notYetAcknowledged").vlText(.label).foregroundStyle(Color.vl.textSecondary)
                }
            }
            .accessibilityElement(children: .combine)
            HStack(alignment: .center, spacing: VL.Space.s4) {
                QRCode(text: ReceiptFormatting.internalLink(materialId: d.materialId))
                    .frame(width: 88, height: 88)
                    .accessibilityLabel(Text("receipt.qr"))
                Text("receipt.qr.caption").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
            }
            if !d.receiptNumber.isEmpty {
                HStack(spacing: VL.Space.s3) {
                    if let image = renderShareImage(d) {
                        ShareLink(item: image, preview: SharePreview(Text("receipt.share.preview \(d.receiptNumber)"), image: image)) {
                            Label("receipt.share", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(.vlGhost)
                    }
                    Button {
                        UIPasteboard.general.string = d.receiptNumber
                        copied = true
                    } label: { Label(LocalizedStringKey(copied ? "receipt.copied" : "receipt.copy"), systemImage: copied ? "checkmark" : "doc.on.doc") }
                        .buttonStyle(.vlGhost)
                }
            }
        }
    }

    @ViewBuilder private var actionButtons: some View {
        Button("receipt.again") { dismiss(); onSendAnother() }.buttonStyle(.vlOutline)
        Button("materials.title") { dismiss(); onMyMaterials() }.buttonStyle(.vlSolid)
    }

    /// صورة PNG للمشاركة داخل المؤسسة عبر ورقة النظام: رقم الإيصال ووقت الاستلام وحدهما (لا بصمة ولا عنوان ولا رمز).
    @MainActor private func renderShareImage(_ d: ReceiptDetails) -> Image? {
        let renderer = ImageRenderer(content:
            VStack(alignment: .leading, spacing: VL.Space.s4) {
                Text("receipt.card.title").vlText(.label).foregroundStyle(Color.vl.textSecondary)
                Text(verbatim: d.receiptNumber).vlText(.receipt).foregroundStyle(Color.vl.textPrimary).environment(\.layoutDirection, .leftToRight)
                if let at = d.receivedAt {
                    Text(verbatim: VLFormat.time(at, now: .distantPast)).vlText(.num).foregroundStyle(Color.vl.textSecondary)
                        .environment(\.layoutDirection, .leftToRight)
                }
            }
            .padding(VL.Space.s7)
            .frame(width: 1080 / 3, height: 1350 / 3, alignment: .topLeading)
            .background(Color.vl.bgBase)
            .environment(\.locale, Locale.current)
        )
        renderer.scale = 3
        guard let ui = renderer.uiImage else { return nil }
        return Image(uiImage: ui)
    }

    /// قرار المراسل يُطبَّق لحظة وضع العلامة، لا عند مغادرة الإيصال: قفل الهاتف والإيصال مفتوح، أو إنهاء التطبيق، لا يُبقي النسخ
    /// (للسلامة عند المصادرة). يشمل نسخ ما تحقّق أو طوبق من ملفات النطاق وحده. الإبقاء لا يُسجَّل فيعود السؤال مع الإيصال التالي.
    private func deleteLocalCopies() {
        guard !deletedLocal else { return }
        for rec in withLocalCopy {
            queue.deleteLocalCopy(rec)
            settings.markLocalCopyHandled(rec.materialId)
        }
        deletedLocal = true
    }

    /// المادة من الخادم (العنوان واطّلاع المشرف وإيصال الأصل)؛ بلا شبكة يكفي سجل الرفع المحلي.
    private func load() async {
        guard batch == nil else { return }
        material = try? await MaterialsAPI.getMaterial(id: target.materialId, apiConfiguration: app.api)
    }
}

/// مربّع اختيار: مربّع 24 بعلامة ✓، والصف كله هدف لمس ≥ 44؛ قارئ الشاشة يراه مفتاحًا.
struct VLCheckboxStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(alignment: .top, spacing: VL.Space.s4) {
                Image(systemName: configuration.isOn ? "checkmark.square.fill" : "square")
                    .font(.title2)
                    .foregroundStyle(configuration.isOn ? Color.vl.actionPrimary : Color.vl.borderEdge)
                configuration.label
                Spacer(minLength: 0)
            }
            .padding(VL.Space.s4)
            .frame(maxWidth: .infinity, minHeight: VL.Size.touchMin, alignment: .leading)
            .background(Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous).strokeBorder(Color.vl.borderLine, lineWidth: VL.Border.hairline))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(Text(LocalizedStringKey(configuration.isOn ? "a11y.on" : "a11y.off")))
        .accessibilityAddTraits(configuration.isOn ? [.isToggle, .isSelected] : [.isToggle])
    }
}

/// ما تعرضه بطاقة الإيصال لمادة واحدة، من المادة إن وصلت أو من سجل الرفع المحلي.
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

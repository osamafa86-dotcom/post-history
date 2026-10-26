import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UploadCore

/// A2 · الرفع يستأنف (docs/design/specs/reporter.md): بطاقة الرفع النشط، والمسودات، وقائمة الانتظار.
struct UploadsScreen: View {
    @EnvironmentObject private var queue: UploadQueueModel
    @Binding var editingDraft: MaterialDraft?

    private var originals: [UploadRecord] { queue.records.filter { $0.kind == .original } }
    private var active: UploadRecord? { originals.first { !$0.phase.isTerminal } }
    private var others: [UploadRecord] { originals.filter { $0.id != active?.id }.sorted { $0.createdAt > $1.createdAt } }

    var body: some View {
        List {
            if !queue.drafts.isEmpty {
                Section {
                    ForEach(queue.drafts) { draft in
                        Button { editingDraft = draft } label: { DraftRow(draft: draft) }
                            .buttonStyle(.plain)
                            .swipeActions { Button("draft.delete", role: .destructive) { queue.deleteDraft(draft.id) } }
                    }
                } header: { VLOverline("drafts.title") }
                .listRowBackground(Color.vl.bgSurface)
            }
            if let active {
                Section {
                    ActiveUploadCard(record: active)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .swipeActions { Button("upload.cancel", role: .destructive) { Task { await queue.cancel(active) } } }
                }
            }
            if !others.isEmpty {
                Section {
                    ForEach(others) { rec in
                        QueueRow(record: rec)
                            .swipeActions {
                                if rec.phase.isTerminal {
                                    Button("upload.remove", role: .destructive) { Task { await queue.remove(rec) } }
                                } else {
                                    Button("upload.cancel", role: .destructive) { Task { await queue.cancel(rec) } }
                                }
                            }
                    }
                } header: { VLOverline("uploads.queue") }
                .listRowBackground(Color.vl.bgSurface)
            }
            if active == nil, others.isEmpty, queue.drafts.isEmpty {
                Text("home.uploads.empty").vlText(.bodyMd).foregroundStyle(Color.vl.textSecondary)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.vl.bgCanvas.ignoresSafeArea())
    }
}

/// مسودة محفوظة على الجهاز: عنوانها (أو «بلا عنوان») وشارة محايدة.
private struct DraftRow: View {
    let draft: MaterialDraft

    var body: some View {
        HStack(spacing: VL.Space.s4) {
            VStack(alignment: .leading, spacing: VL.Space.s2) {
                Group { if draft.title.isEmpty { Text("draft.untitled") } else { Text(verbatim: draft.title) } }
                    .vlText(.labelMd).foregroundStyle(Color.vl.textPrimary).lineLimit(2)
                Text("stepper.position \(draft.step) \(4) \(Text(LocalizedStringKey(NewMaterialFlow.Step(rawValue: draft.step)?.titleKey ?? "")))")
                    .vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
            }
            Spacer()
            StateBadge(labelKey: "draft.badge", tone: .neutral)
        }
        .frame(minHeight: VL.Size.touchMin)
    }
}

/// بطاقة الرفع النشط: ثلاث حقائق دائمًا (أين وصلنا، أن الانقطاع آمن، وما الخطوة التالية).
struct ActiveUploadCard: View {
    @EnvironmentObject private var queue: UploadQueueModel
    @EnvironmentObject private var settings: AppSettings
    let record: UploadRecord

    private var proxy: UploadRecord? { queue.records.first { $0.kind == .proxy && $0.materialId == record.materialId } }
    private var paused: Bool { record.isPaused == true }
    private var networkBlocked: Bool { queue.networkState != .online && !record.phase.isTerminal }

    var body: some View {
        VLCard(border: networkBlocked || paused ? Color.vl.toneNeutralBorder : Color.vl.toneProgressBorder) {
            header
            lightCopyLine
            progressBlock
            reassurance
            actions
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            HStack(alignment: .top, spacing: VL.Space.s3) {
                Text(verbatim: record.materialTitle ?? record.filename).vlText(.headingH4).foregroundStyle(Color.vl.textPrimary).lineLimit(2)
                Spacer(minLength: 0)
                if let raw = record.materialPriority, let p = Priority(rawValue: raw) { PriorityBadge(priority: p) }
            }
            Text(verbatim: "\(record.filename) · \(ByteCountFormatter.string(fromByteCount: record.sizeBytes, countStyle: .file))")
                .vlText(.captionMd).foregroundStyle(Color.vl.textSecondary).lineLimit(1)
        }
    }

    @ViewBuilder private var lightCopyLine: some View {
        if let proxy, case .verified = proxy.phase {
            HStack(spacing: VL.Space.s3) {
                StateBadge(labelKey: "material.technical.verified", tone: .good, track: .technical)
                Text("proxy.arrived \(proxy.updatedAt.formatted(date: .omitted, time: .shortened))")
                    .vlText(.bodySm).foregroundStyle(Color.vl.textSecondary)
            }
        } else if let proxy, !proxy.phase.isTerminal {
            VStack(alignment: .leading, spacing: VL.Space.s2) {
                Text("proxy.uploading").vlText(.labelMd).foregroundStyle(Color.vl.textPrimary)
                ProgressView(value: proxy.fractionTransferred).tint(Color.vl.bgBrand)
            }
        } else if queue.preparingProxy.contains(record.materialId) {
            Label("upload.preparingProxy", systemImage: "wand.and.rays").vlText(.bodySm).foregroundStyle(Color.vl.textSecondary)
        }
    }

    @ViewBuilder private var progressBlock: some View {
        if paused {
            stateLine("upload.paused", systemImage: "pause.circle")
            bar(fraction: record.fractionTransferred, color: Color.vl.toneNeutralBorder)
        } else if networkBlocked {
            stateLine(queue.networkState == .waitingForWifi ? "upload.waitingForWifi" : "upload.waitingForNetwork", systemImage: "wifi.slash")
            bar(fraction: record.fractionTransferred, color: Color.vl.toneNeutralBorder)
        } else {
            switch record.phase {
            case .hashing, .creatingSession, .creatingUpload:
                HStack(spacing: VL.Space.s3) {
                    ProgressView()
                    Text(LocalizedStringKey(queue.waitingForProxy.contains(record.id) ? "upload.waitingForProxy" : "upload.state.preparing"))
                        .vlText(.labelLg).foregroundStyle(Color.vl.textPrimary)
                }
            case .transferring:
                transferring
            case .completing, .awaitingReceipt:
                stateLine("upload.awaitingReceipt", systemImage: "checkmark.seal")
                bar(fraction: 1, color: Color.vl.toneProgressBorder)
            case .failed(let failure):
                VLInlineAlert(tone: .bad, systemImage: "xmark.octagon.fill", textKey: failure.textKey, actionKey: "upload.retry") {
                    Task { await queue.retry(record) }
                }
            case .verified, .deduplicated, .cancelled:
                EmptyView()
            }
        }
    }

    private var transferring: some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            HStack(alignment: .firstTextBaseline, spacing: VL.Space.s3) {
                Text(record.fractionTransferred, format: .percent.precision(.fractionLength(0)))
                    .vlText(.displayMd).foregroundStyle(Color.vl.textBrand)
                    .environment(\.layoutDirection, .leftToRight)
                Text("upload.originalUploading").vlText(.labelLg).foregroundStyle(Color.vl.textPrimary)
            }
            Text(bytesLine).vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
            bar(fraction: record.fractionTransferred, color: Color.vl.bgBrand)
            ChunkBarsView(bars: chunkBars)
            Text("chunks.status \(chunkBars.confirmedParts) \(chunkBars.totalParts) \(chunkBars.inFlightPart ?? 0)")
                .vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var chunkBars: ChunkBars {
        ChunkBars(sizeBytes: record.sizeBytes, chunkSizeBytes: record.chunkSizeBytes, confirmedOffset: record.confirmedOffset, inFlightOffset: record.inFlightOffset)
    }

    private var bytesLine: LocalizedStringKey {
        let done = ByteCountFormatter.string(fromByteCount: record.confirmedOffset, countStyle: .file)
        let total = ByteCountFormatter.string(fromByteCount: record.sizeBytes, countStyle: .file)
        guard let eta = queue.etaSeconds[record.id] else { return "upload.bytes \(done) \(total)" }
        let left = Duration.seconds(eta).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .abbreviated, maximumUnitCount: 2))
        return "upload.bytesEta \(done) \(total) \(left)"
    }

    private func stateLine(_ key: String, systemImage: String) -> some View {
        Label(LocalizedStringKey(key), systemImage: systemImage).vlText(.labelLg).foregroundStyle(Color.vl.textPrimary)
    }

    private func bar(fraction: Double, color: Color) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.vl.bgSubtle)
                Capsule().fill(color).frame(width: geo.size.width * min(max(fraction, 0), 1))
                    .animation(VL.Easing.linear(VL.Duration.progress), value: fraction)
            }
        }
        .frame(height: VL.Space.s3 + VL.Space.s1)
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityHidden(true)
    }

    private var reassurance: some View {
        Label { Text("upload.reassurance").vlText(.bodySm).foregroundStyle(Color.vl.textPrimary) } icon: {
            Image(systemName: "shield.lefthalf.filled").foregroundStyle(Color.vl.iconBrand)
        }
        .padding(VL.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.vl.bgBrandSubtle, in: RoundedRectangle(cornerRadius: VL.Radius.md))
    }

    @ViewBuilder private var actions: some View {
        if !record.phase.isTerminal {
            HStack(spacing: VL.Space.s3) {
                Button {
                    Task { if paused { await queue.resume(record) } else { await queue.pause(record) } }
                } label: { Label(LocalizedStringKey(paused ? "upload.resume" : "upload.pause"), systemImage: paused ? "play.fill" : "pause.fill") }
                    .buttonStyle(.vlSecondary)
                Button {
                    settings.uploadOverWifiOnly.toggle()
                    queue.updateNetworkState()
                } label: { Label(LocalizedStringKey(settings.uploadOverWifiOnly ? "upload.wifiOnly.on" : "upload.wifiOnly.off"), systemImage: "wifi") }
                    .buttonStyle(.vlGhost)
            }
        }
    }
}

/// شرائط الأجزاء: مؤكَّد / جارٍ / لاحق، 12 حدًّا أقصى.
struct ChunkBarsView: View {
    let bars: [ChunkBars.State]

    var body: some View {
        HStack(spacing: VL.Space.s1) {
            ForEach(bars.indices, id: \.self) { i in
                RoundedRectangle(cornerRadius: VL.Radius.full)
                    .fill(color(bars[i]))
                    .frame(width: VL.Space.s7, height: VL.Space.s2 + VL.Space.s1)
            }
        }
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityHidden(true)
    }

    private func color(_ s: ChunkBars.State) -> Color {
        switch s {
        case .confirmed: return .vl.bgBrand
        case .inFlight: return .vl.toneProgressBorder
        case .pending: return .vl.borderDefault
        }
    }
}

/// صف في قائمة الانتظار: العنوان وحالته، والإيصال بخط أحادي للمستلم.
private struct QueueRow: View {
    @EnvironmentObject private var queue: UploadQueueModel
    let record: UploadRecord

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            Text(verbatim: record.materialTitle ?? record.filename).vlText(.labelMd).foregroundStyle(Color.vl.textPrimary).lineLimit(2)
            switch record.phase {
            case .verified(let receipt):
                Button { queue.presentedReceipt = ReceiptTarget(materialId: record.materialId, recordId: record.id) } label: {
                    Label { Text(verbatim: receipt).vlText(.monoMd).environment(\.layoutDirection, .leftToRight) } icon: {
                        Image(systemName: "checkmark.seal.fill").foregroundStyle(Color.vl.toneGoodFg)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("upload.receipt \(receipt)"))
            case .failed(let failure):
                Text(failure.labelKey).vlText(.captionMd).foregroundStyle(Color.vl.textDanger)
            default:
                Text(record.isPaused == true ? "upload.paused" : record.phase.labelKey).vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
            }
        }
        .frame(minHeight: VL.Size.touchMin, alignment: .leading)
    }
}

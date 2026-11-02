import AVFoundation
import ImageIO
import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UIKit

// مكوّنات الرفع والإيصال والمعرض (05–07 في reporter-v2.md، وdesign-system-v2.md «المكوّنات»).

// MARK: - المصغّرات المحلية

/// مصغّرات «موادي» والرفع في الذاكرة وحدها: من نسخ الملفات على الجهاز، ومن مشتق `thumbnail` متحقَّق على الخادم برابط موقّع
/// يُطلب قبيل التحميل ولا يُحفظ (ADR 0089). لا مصغّرة تُكتب على القرص؛ الذاكرة محدودة (`NSCache` يُفرَغ أيضًا عند ضغط الذاكرة)،
/// وتُمحى مع المسح الطارئ والخروج والإبطال. ومعها مدد الفيديو المحلية للبطاقات.
@MainActor
final class ThumbnailCache {
    static let shared = ThumbnailCache()

    private final class Entry {
        let image: Image
        init(_ image: Image) { self.image = image }
    }

    private let images = NSCache<NSString, Entry>()
    private var durations: [String: Double] = [:]
    /// يرتفع مع كل محو، فتحميل بدأ قبله لا يعيد ما مُحي.
    private var generation = 0

    init() { images.countLimit = 160 }

    func image(relativePath: String, isVideo: Bool, maxPixel: CGFloat = 240) async -> Image? {
        let key = "local:\(relativePath)#\(Int(maxPixel))" as NSString
        if let cached = images.object(forKey: key) { return cached.image }
        let url = UploadServices.shared.documentsDirectory.appendingPathComponent(relativePath)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let gen = generation
        var made: CGImage?
        if isVideo {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: maxPixel, height: maxPixel)
            made = try? await generator.image(at: .zero).image
        } else {
            made = await MediaImages.downsample(fileURL: url, maxPixel: maxPixel)
        }
        guard let made else { return nil }
        let image = Image(decorative: made, scale: 1)
        if gen == generation { images.setObject(Entry(image), forKey: key) }
        return image
    }

    /// مصغّرة من مشتق على الخادم: `link` يطلب الرابط الموقّع لحظتها، والبايتات بجلسة بلا ذاكرة ولا قرص (`MediaImages.session`).
    func remoteImage(fileId: UUID, maxPixel: CGFloat, link: @Sendable () async throws -> FileDownloadUrl) async -> Image? {
        let key = "remote:\(fileId.uuidString)#\(Int(maxPixel))" as NSString
        if let cached = images.object(forKey: key) { return cached.image }
        let gen = generation
        guard let lease = (try? await link()).flatMap({ SignedURLLease($0) }),
              let data = await MediaImages.data(lease.url),
              let made = await MediaImages.downsample(data: data, maxPixel: maxPixel) else { return nil }
        let image = Image(decorative: made, scale: 1)
        if gen == generation { images.setObject(Entry(image), forKey: key) }
        return image
    }

    /// مدة فيديو على الهاتف بالثواني (حين لا يعرفها الخادم بعد).
    func duration(relativePath: String) async -> Double? {
        if let known = durations[relativePath] { return known }
        let url = UploadServices.shared.documentsDirectory.appendingPathComponent(relativePath)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let gen = generation
        guard let time = try? await AVURLAsset(url: url).load(.duration), time.isNumeric else { return nil }
        let seconds = CMTimeGetSeconds(time)
        if gen == generation { durations[relativePath] = seconds }
        return seconds
    }

    func clear() {
        generation += 1
        images.removeAllObjects()
        durations.removeAll()
    }
}

/// تحميل الصور وتصغيرها خارج الخيط الرئيسي. الجلسة عابرة بلا ذاكرة طلبات ولا كعكات ولا قرص، فلا يبقى من الرابط الموقّع ولا من
/// البايتات شيء بعد التحميل؛ ولا يُسجَّل رابط ولا اسم ملف.
enum MediaImages {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    /// مصغّرات لا صور كاملة: حدّ للحجم يمنع تحميل ملف كبير بالخطأ.
    static let maxBytes = 12 << 20

    static func data(_ url: URL) async -> Data? {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), data.count <= maxBytes else { return nil }
        return data
    }

    static func downsample(data: Data, maxPixel: CGFloat) async -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return thumbnail(source, maxPixel: maxPixel)
    }

    static func downsample(fileURL: URL, maxPixel: CGFloat) async -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return thumbnail(source, maxPixel: maxPixel)
    }

    private static func thumbnail(_ source: CGImageSource, maxPixel: CGFloat) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

/// مصغّرة ملف محلي بزاوية، أو سطح غائر بأيقونة النوع إن لم تتوفر النسخة.
struct LocalThumbnail: View {
    let relativePath: String?
    let isVideo: Bool
    var width: CGFloat = 40
    var height: CGFloat = 40
    var radius: CGFloat = VL.Space.s3

    @State private var image: Image?

    var body: some View {
        ZStack {
            Color.vl.bgSunken
            if let image {
                image.resizable().scaledToFill()
            } else {
                Image(systemName: isVideo ? "film" : "photo").foregroundStyle(Color.vl.textSecondary)
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .accessibilityHidden(true)
        .task(id: relativePath) {
            guard let relativePath else { image = nil; return }
            image = await ThumbnailCache.shared.image(relativePath: relativePath, isVideo: isVideo)
        }
    }
}

// MARK: - صف الرفع

/// ما يقوله صف الرفع عن ملفه: كلمة وأيقونة ونغمة، فلا تُقال الحالة باللون وحده.
struct UploadRowStatus: Equatable {
    var textKey: LocalizedStringKey?
    var percent: Double?
    var systemImage: String?
    var tone: VLTone

    static func make(_ item: UploadItem, network: UploadQueueModel.NetworkState) -> UploadRowStatus {
        let stage = UploadOverview.stage(item)
        switch item.state {
        case .arrived:
            return UploadRowStatus(textKey: LocalizedStringKey(stage.labelKey), systemImage: "checkmark", tone: .ok)
        case .failed:
            return UploadRowStatus(textKey: "upload.row.failed", systemImage: "exclamationmark.triangle", tone: .danger)
        case .cancelled:
            return UploadRowStatus(textKey: "upload.phase.cancelled", systemImage: "xmark", tone: .muted)
        case .preparing, .transferring, .finishing:
            if network == .offline { return UploadRowStatus(textKey: "upload.waitingForNetwork", systemImage: "wifi.slash", tone: .warn) }
            if network == .waitingForWifi { return UploadRowStatus(textKey: "upload.waitingForWifi", systemImage: "wifi.slash", tone: .warn) }
            if item.paused { return UploadRowStatus(textKey: "upload.paused", systemImage: "pause", tone: .muted) }
            if stage >= .preview { return UploadRowStatus(textKey: LocalizedStringKey(stage.labelKey), systemImage: "checkmark", tone: .ok) }
            switch item.state {
            case .finishing: return UploadRowStatus(textKey: "upload.awaitingReceipt", systemImage: "checkmark.seal", tone: .brand)
            case .preparing: return UploadRowStatus(textKey: "upload.state.preparing", systemImage: "clock", tone: .muted)
            default:
                let fraction = item.sizeBytes > 0 ? Double(item.confirmedOffset) / Double(item.sizeBytes) : 0
                return UploadRowStatus(percent: min(max(fraction, 0), 1), tone: .brand)
            }
        }
    }
}

/// `Upload row`: المصغّرة والعنوان، ثم المرحلة بكلمة ونقاط ثلاث أو النسبة، وشريط التقدّم أثناء النقل.
/// لا حذف بالسحب: الإجراءات أزرار تحتها، والإلغاء بتأكيد (ADR 0081).
struct UploadRow<Actions: View>: View {
    let title: String
    let thumbnailPath: String?
    let isVideo: Bool
    let item: UploadItem
    let status: UploadRowStatus
    @ViewBuilder var actions: Actions

    private var stage: UploadStage { UploadOverview.stage(item) }
    private var showsBar: Bool { item.state == .transferring && status.percent != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            HStack(alignment: .center, spacing: VL.Space.s4) {
                LocalThumbnail(relativePath: thumbnailPath, isVideo: isVideo)
                VStack(alignment: .leading, spacing: VL.Space.s2) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: VL.Space.s3) {
                            name
                            Spacer(minLength: VL.Space.s3)
                            statusLine
                        }
                        VStack(alignment: .leading, spacing: VL.Space.s1) {
                            name
                            statusLine
                        }
                    }
                    if showsBar { bar }
                }
            }
            .accessibilityElement(children: .combine)
            actions
        }
        .padding(.horizontal, VL.Space.s4)
        .padding(.vertical, VL.Space.s3)
        .frame(maxWidth: .infinity, minHeight: VL.Size.touchMin + VL.Space.s5, alignment: .leading)
        .background(Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous).strokeBorder(Color.vl.borderLine, lineWidth: VL.Border.hairline))
    }

    private var name: some View {
        Text(verbatim: title).vlText(.headline).foregroundStyle(Color.vl.textPrimary).lineLimit(3)
    }

    private var statusLine: some View {
        HStack(spacing: VL.Space.s2) {
            if let percent = status.percent {
                Text(verbatim: VLFormat.percent(percent))
                    .vlText(.num)
                    .environment(\.layoutDirection, .leftToRight)
            } else {
                if let image = status.systemImage { Image(systemName: image).imageScale(.small) }
                if let key = status.textKey { Text(key).vlText(.label) }
            }
            StageDots(stage: stage)
        }
        .foregroundStyle(status.tone.color)
    }

    private var bar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.vl.bgSunken)
                Capsule().fill(Color.vl.actionPrimary).frame(width: geo.size.width * (status.percent ?? 0))
            }
        }
        .frame(height: VL.Space.s2)
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityHidden(true)
    }
}

extension UploadRow where Actions == EmptyView {
    init(title: String, thumbnailPath: String?, isVideo: Bool, item: UploadItem, status: UploadRowStatus) {
        self.init(title: title, thumbnailPath: thumbnailPath, isVideo: isVideo, item: item, status: status) { EmptyView() }
    }
}

/// النقاط الثلاث للمراحل: الممتلئة ما بلغه الملف. زخرفية؛ كلمة المرحلة تقولها.
struct StageDots: View {
    let stage: UploadStage

    var body: some View {
        HStack(spacing: VL.Space.s1 + 1) {
            ForEach(1...3, id: \.self) { i in
                Circle()
                    .fill(i <= stage.rawValue ? Color.vl.stateOk : Color.vl.borderLine)
                    .frame(width: 6, height: 6)
            }
        }
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityHidden(true)
    }
}

/// تأكيد إلغاء الرفع: واحد لكل مواضع الإلغاء كي لا يختلف النص ولا يُلغى رفع بلمسة واحدة (ADR 0081).
struct CancelUploadConfirmation: ViewModifier {
    @Binding var isPresented: Bool
    let confirm: () -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog("upload.cancel.confirm.title", isPresented: $isPresented, titleVisibility: .visible) {
            Button("upload.cancel.confirm.action", role: .destructive, action: confirm)
            Button("upload.cancel.confirm.keep", role: .cancel) {}
        } message: {
            Text("upload.cancel.confirm.message")
        }
    }
}

// MARK: - الإيصال

/// `Receipt`: صفوف تسمية وقيمة؛ القيم LTR، ورقم الإيصال والبصمة بخط أحادي، والوقت والحجم بأرقام Rubik الجدولية.
/// لا اسم مصدر ولا موقع.
struct ReceiptSlip: View {
    struct Row: Identifiable {
        let id = UUID()
        let label: LocalizedStringKey
        let value: String
        var mono = false
        var a11yValue: Text?
    }

    let rows: [Row]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: VL.Space.s4) {
                        Text(row.label).vlText(.label).foregroundStyle(Color.vl.textSecondary)
                        Spacer(minLength: VL.Space.s3)
                        value(row)
                    }
                    VStack(alignment: .leading, spacing: VL.Space.s1) {
                        Text(row.label).vlText(.label).foregroundStyle(Color.vl.textSecondary)
                        value(row)
                    }
                }
                .padding(.vertical, VL.Space.s3)
                .accessibilityElement(children: .combine)
                if index < rows.count - 1 { Divider().overlay(Color.vl.borderLine) }
            }
        }
        .padding(.horizontal, VL.Space.s5)
        .padding(.vertical, VL.Space.s1)
        .background(Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous).strokeBorder(Color.vl.borderEdge, lineWidth: VL.Border.field))
    }

    private func value(_ row: Row) -> some View {
        Text(verbatim: row.value)
            .vlText(row.mono ? .receipt : .num)
            .foregroundStyle(Color.vl.textPrimary)
            .textSelection(.enabled)
            .environment(\.layoutDirection, .leftToRight)
            .accessibilityLabel(row.a11yValue ?? Text(verbatim: row.value))
    }
}

// MARK: - المعرض

/// `Media card` (Video · Photo) لمعرض «موادي»: مصغّرة 9:16 بمدتها، وتحتها الحالات الثلاث شاراتٍ منفصلة.
/// المادة الموسومة بالحساسية لا معاينة سحابية لها، فتظهر شارة «حسّاسة» بدل الصورة إن لم تتوفر نسخة محلية (CLAUDE.md §5).
/// `title` يظهر تحت الصورة حين لا يكون عنوان المجموعة عنوانها (التجميع بالنوع).
struct MediaCard: View {
    enum Kind { case video, photo }

    let kind: Kind
    var thumbnail: Image?
    var duration: String?
    let status: MaterialStatus
    var sensitive = false
    var title: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            ZStack {
                Color.vl.bgSunken
                if let thumbnail {
                    thumbnail.resizable().scaledToFill()
                } else if sensitive {
                    VStack(spacing: VL.Space.s2) {
                        Image(systemName: "shield")
                        Text("media.sensitive.noCloud").vlText(.caption).multilineTextAlignment(.center)
                        Text("media.sensitive.local").vlText(.caption).multilineTextAlignment(.center)
                    }
                    .foregroundStyle(Color.vl.textSecondary)
                    .padding(VL.Space.s3)
                } else {
                    // لا معاينة بعد (قيد المعالجة): أيقونة النوع هادئة، فلا يبدو الفراغ خطأً.
                    Image(systemName: kind == .video ? "film" : "photo")
                        .font(.title2)
                        .foregroundStyle(Color.vl.textSecondary)
                }
            }
            .aspectRatio(9 / 16, contentMode: .fit)
            .overlay(alignment: .topTrailing) {
                pill { Image(systemName: kind == .video ? "film" : "photo").imageScale(.small) }
                    .padding(VL.Space.s2)
                    .accessibilityHidden(true)
            }
            .overlay(alignment: .bottomTrailing) {
                if let duration {
                    pill { Text(verbatim: duration).vlText(.caption).monospacedDigit() }
                        .environment(\.layoutDirection, .leftToRight)
                        .padding(VL.Space.s2)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: VL.Radius.sm, style: .continuous))
            if let title {
                Text(verbatim: title).vlText(.label).foregroundStyle(Color.vl.textPrimary).lineLimit(2)
            }
            if sensitive {
                StateBadge(labelKey: "media.sensitive", tone: .warn, systemImage: "shield")
            }
            ThreeStateBadges(status: status)
        }
        .accessibilityElement(children: .combine)
    }

    /// شارة صغيرة على الصورة بألوان وجه العرض الثابتة في الوضعين (`bg/store` و`text/on-store`) كي تُقرأ فوق أي صورة.
    private func pill<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .foregroundStyle(Color.vl.textOnStore)
            .padding(.horizontal, VL.Space.s2)
            .padding(.vertical, VL.Space.s1)
            .background(Color.vl.bgStore.opacity(0.8), in: Capsule())
    }
}

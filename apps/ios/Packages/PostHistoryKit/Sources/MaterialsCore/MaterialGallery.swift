import Foundation
import PostHistoryAPI

// معرض «موادي» (design-brief.md §5.3، reporter-v2.md «موادي»، الإطارات 07–07c؛ ADR 0089): الأحدث أولًا، مجمّعة بعنوان
// التغطية أو بنوعها، بفلاتر التاريخ والنوع والحالة. منطق صرف بلا واجهة، مختبر على Linux.

/// نوع الوسيط كما يراه المراسل في المعرض.
public enum MediaKind: String, CaseIterable, Sendable { case video, photo }

extension Material {
    /// المادة موسومة بالحساسية (أيٌّ من الأسئلة الثلاثة «نعم»): لا معاينة سحابية لها في المعرض (07c، CLAUDE.md §5).
    public var isSensitive: Bool { sensitivity.minors || sensitivity.injured || sensitivity.graphic }

    /// نوع التغطية الأول بترتيب العقد: عنوان مجموعتها في التجميع بالنوع وسطرها الفرعي في التجميع بالعنوان.
    public var primaryType: MaterialType? {
        MaterialType.allCases.first { $0 != .unknownDefaultOpenApi && materialTypes.contains($0) }
    }
}

/// حقائق الوسيط من ملفات المادة في العقد، ومن سجل الأصل على الهاتف حين يغيب نوعه عن الخادم.
public enum MaterialMedia {
    private static let imageExtensions: Set<String> = ["jpg", "jpeg", "heic", "heif", "png", "gif", "webp", "tif", "tiff", "dng"]

    /// صورة لا فيديو: بنوع MIME إن وُجد، وإلا بامتداد الملف.
    public static func isImage(mimeType: String?, path: String? = nil) -> Bool {
        if let mime = mimeType?.lowercased(), !mime.isEmpty { return mime.hasPrefix("image/") }
        guard let ext = path.map({ ($0 as NSString).pathExtension.lowercased() }), !ext.isEmpty else { return false }
        return imageExtensions.contains(ext)
    }

    /// فيديو أو صورة: نوع الأصل على الخادم، ثم سجله على الهاتف، ثم وجود مشتق مرئي متحرك أو مدة، ثم نوع التغطية «صور» وحده.
    /// ما لا يُعرف يُعدّ فيديو (أغلب ما يرسله المراسلون، والمشغّل يقول إن لم يجد ما يُشغَّل).
    public static func kind(of m: Material, localMimeType: String? = nil) -> MediaKind {
        for mime in [m.originalFile?.mimeType, localMimeType] {
            guard let mime = mime?.lowercased(), !mime.isEmpty else { continue }
            if mime.hasPrefix("image/") { return .photo }
            if mime.hasPrefix("video/") { return .video }
        }
        if m.files.contains(where: { $0.kind == .proxy || $0.kind == .hls || ($0.durationMs ?? 0) > 0 }) { return .video }
        if m.materialTypes == [.photos] { return .photo }
        return .video
    }

    /// مدة الفيديو بالملّي ثانية من الخادم: الأصل ثم نسخة البث ثم النسخة الخفيفة؛ أول قيمة موجبة.
    public static func durationMs(of m: Material) -> Int? {
        for kind in [MaterialFile.Kind.original, .hls, .proxy] {
            if let d = m.files.first(where: { $0.kind == kind && ($0.durationMs ?? 0) > 0 })?.durationMs { return d }
        }
        return nil
    }
}

/// عنوان التغطية (design-brief.md §9: «التغطية» عنوان الإرسالة الواحدة): العنوان بلا لاحقة ملفات الإرسالة ` (i/N)` (ADR 0081)
/// مطبَّعًا، ومفتاحه بالمطابقة العربية المطويّة؛ فمواد الإرسالة الواحدة مجموعة واحدة ولو اختلفت همزة أو مسافة.
public enum CoverageTitle {
    /// يُعرض عنوانًا للمجموعة.
    public static func display(_ title: String) -> String {
        let normalized = MaterialTagRules.normalize(title)
        let stripped = MaterialTagRules.normalize(stripBatchSuffix(normalized))
        return stripped.isEmpty ? normalized : stripped
    }

    public static func key(_ title: String) -> String { ArabicFold.key(display(title)) }

    /// ` (i/N)` في آخر العنوان بأرقام ASCII، و1 ≤ i ≤ N و N ≥ 2؛ وما سواها جزء من العنوان.
    static func stripBatchSuffix(_ title: String) -> String {
        guard title.hasSuffix(")"), let open = title.range(of: " (", options: .backwards) else { return title }
        let inner = title[open.upperBound..<title.index(before: title.endIndex)]
        let parts = inner.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, parts.allSatisfy({ !$0.isEmpty && $0.count <= 3 && $0.allSatisfy { $0.isASCII && $0.isNumber } }),
              let i = Int(parts[0]), let n = Int(parts[1]), n >= 2, (1...n).contains(i) else { return title }
        return String(title[..<open.lowerBound])
    }
}

/// التجميع: بعنوان التغطية (الافتراضي، الإطار 07) أو بنوعها.
public enum GalleryGrouping: String, CaseIterable, Sendable { case coverage, type }

/// الرقاقات السريعة فوق المعرض كما في الإطار 07: الكل · فيديو · صور · عاجل.
public enum GalleryQuickFilter: String, CaseIterable, Sendable { case all, video, photo, urgent }

/// مدى التاريخ بتاريخ الإرسال (`created_at`، ترتيب القائمة نفسه): اليوم، وآخر 7 أيام، وآخر 30 يومًا، بأيام التقويم المحلي.
public enum GalleryDateRange: String, CaseIterable, Sendable { case any, today, week, month }

/// فلتر الحالة بمفردات المسارات الثلاثة في المواصفة، كلٌّ على مساره وحده (الحالات لا تُدمج):
/// تحتاج إجراء (طلب تعديل أو فشل فني) · تُعالَج (فنية) · قيد المراجعة · معتمدة · مرفوضة (تحريرية) · للعرض (حقوق).
public enum GalleryStateFilter: String, CaseIterable, Sendable { case needsAction, processing, inReview, approved, rejected, listed }

public struct GalleryFilter: Equatable, Sendable {
    public var quick: GalleryQuickFilter
    public var dateRange: GalleryDateRange
    public var coverageType: MaterialType?
    public var state: GalleryStateFilter?

    public init(quick: GalleryQuickFilter = .all, dateRange: GalleryDateRange = .any, coverageType: MaterialType? = nil,
                state: GalleryStateFilter? = nil) {
        self.quick = quick
        self.dateRange = dateRange
        self.coverageType = coverageType
        self.state = state
    }

    /// ما فُعّل في ورقة «العرض والتصفية» (الرقاقات السريعة ظاهرة فوق المعرض فلا تُعدّ هنا).
    public var sheetCount: Int { (dateRange == .any ? 0 : 1) + (coverageType == nil ? 0 : 1) + (state == nil ? 0 : 1) }
    public var isActive: Bool { quick != .all || sheetCount > 0 }

    public func matches(_ m: Material, kind: MediaKind, now: Date, calendar: Calendar) -> Bool {
        switch quick {
        case .all: break
        case .video: guard kind == .video else { return false }
        case .photo: guard kind == .photo else { return false }
        case .urgent: guard m.priority == .urgent else { return false }
        }
        if let coverageType, !m.materialTypes.contains(coverageType) { return false }
        if let state, !Self.matches(m, state: state) { return false }
        return Self.contains(dateRange, m.createdAt, now: now, calendar: calendar)
    }

    static func matches(_ m: Material, state: GalleryStateFilter) -> Bool {
        let s = MaterialStatus(m)
        func tone(_ track: MaterialStatus.Track) -> MaterialStatus.SignalTone { MaterialStatus.signalTone(s.badge(track).tone, track: track) }
        switch state {
        case .needsAction: return m.needsAction
        case .processing: return tone(.technical) == .muted
        case .inReview: return tone(.editorial) == .warn
        case .approved: return tone(.editorial) == .ok
        case .rejected: return tone(.editorial) == .danger
        case .listed: return tone(.rights) == .brand
        }
    }

    /// تاريخ في المستقبل (ساعة هاتف متأخرة) يُعدّ ضمن كل مدى.
    static func contains(_ range: GalleryDateRange, _ date: Date, now: Date, calendar: Calendar) -> Bool {
        let days: Int
        switch range {
        case .any: return true
        case .today: days = 0
        case .week: days = 6
        case .month: days = 29
        }
        guard let start = calendar.date(byAdding: .day, value: -days, to: calendar.startOfDay(for: now)) else { return true }
        return date >= start
    }
}

/// مجموعة في المعرض: عنوانها، وأحدث موادها (ترتيب المجموعات ويوم سطرها الفرعي)، وموادها الأحدث أولًا.
public struct GallerySection: Equatable, Sendable, Identifiable {
    public enum Heading: Equatable, Sendable {
        /// عنوان التغطية معروضًا بلا لاحقة الإرسالة.
        case coverage(String)
        /// نوع التغطية؛ `nil` لمادة بلا نوع معروف.
        case type(MaterialType?)
    }

    public let id: String
    public let heading: Heading
    public let newest: Date
    /// نوع أحدث مادة في المجموعة: السطر الفرعي «حدث ميداني · اليوم · 3 مواد» في التجميع بالعنوان.
    public let primaryType: MaterialType?
    public let materials: [Material]
}

/// يوم المجموعة في سطرها الفرعي.
public enum GalleryDay: Equatable, Sendable {
    case today, yesterday
    case date(Date)

    public static func of(_ date: Date, now: Date, calendar: Calendar) -> GalleryDay {
        if calendar.isDate(date, inSameDayAs: now) { return .today }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: y) { return .yesterday }
        return .date(date)
    }
}

public enum MaterialGallery {
    /// المواد بعد الفلتر، الأحدث أولًا، في مجموعات مرتبة بأحدث موادها. `kind` يقرأ نوع الوسيط (ومعه سجل الهاتف) لكل مادة.
    public static func sections(_ items: [Material], grouping: GalleryGrouping, filter: GalleryFilter = GalleryFilter(),
                                kind: (Material) -> MediaKind, now: Date = Date(), calendar: Calendar = .current) -> [GallerySection] {
        let visible = items.enumerated()
            .filter { filter.matches($0.element, kind: kind($0.element), now: now, calendar: calendar) }
            .sorted { $0.element.createdAt != $1.element.createdAt ? $0.element.createdAt > $1.element.createdAt : $0.offset < $1.offset }
            .map(\.element)
        var order: [String] = []
        var groups: [String: [Material]] = [:]
        for m in visible {
            let id = groupId(m, grouping)
            if groups[id] == nil { order.append(id) }
            groups[id, default: []].append(m)
        }
        return order.map { id in
            let members = groups[id] ?? []
            let first = members[0]
            let heading: GallerySection.Heading = grouping == .coverage ? .coverage(CoverageTitle.display(first.title)) : .type(first.primaryType)
            return GallerySection(id: id, heading: heading, newest: first.createdAt, primaryType: first.primaryType, materials: members)
        }
    }

    static func groupId(_ m: Material, _ grouping: GalleryGrouping) -> String {
        switch grouping {
        case .coverage: return "coverage:" + CoverageTitle.key(m.title)
        case .type: return "type:" + (m.primaryType?.rawValue ?? "none")
        }
    }
}

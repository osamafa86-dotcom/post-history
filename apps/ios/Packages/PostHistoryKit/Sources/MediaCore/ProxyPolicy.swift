import Foundation
import PostHistoryAPI

/// وضع النسخة الخفيفة كما في جدول الخطة (ADR 0075): عاجل 360p، عادي 540p، أو الأصل فقط بلا نسخة.
public enum ProxyChoice: String, CaseIterable, Codable, Sendable {
    case urgent, normal, originalOnly

    /// القيمة في `UploadSessionCreate.proxy_mode`؛ `nil` حين لا نسخة خفيفة.
    public var uploadMode: UploadSessionCreate.ProxyMode? {
        switch self {
        case .urgent: return .urgent
        case .normal: return .normal
        case .originalOnly: return nil
        }
    }

    public var preset: ProxyPreset? {
        switch self {
        case .urgent: return .urgent
        case .normal: return .normal
        case .originalOnly: return nil
        }
    }
}

/// إعداد الترميز: الارتفاع الأقصى (البعد الأقصر)، ومعدل الفيديو والصوت بالبت في الثانية.
public struct ProxyPreset: Equatable, Sendable {
    public let shortSide: Int
    public let videoBitsPerSecond: Int
    public let audioBitsPerSecond: Int

    public static let urgent = ProxyPreset(shortSide: 360, videoBitsPerSecond: 600_000, audioBitsPerSecond: 48_000)
    public static let normal = ProxyPreset(shortSide: 540, videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 64_000)

    /// أبعاد الإخراج للعرض كما يُشاهَد (بعد التدوير): البعد الأقصر لا يتجاوز الإعداد، لا تكبير، والأبعاد زوجية.
    public func renderSize(displayWidth: Int, displayHeight: Int) -> (width: Int, height: Int) {
        let w = max(displayWidth, 2), h = max(displayHeight, 2)
        let short = min(w, h)
        let scale = short > shortSide ? Double(shortSide) / Double(short) : 1
        func even(_ v: Double) -> Int { max(2, Int((v / 2).rounded()) * 2) }
        return (even(Double(w) * scale), even(Double(h) * scale))
    }

    /// تقدير حجم النسخة بالبايت لمدة معطاة (للتحقق من المساحة قبل التحضير).
    public func estimatedBytes(durationSeconds: Double) -> Int64 {
        Int64(Double(videoBitsPerSecond + audioBitsPerSecond) / 8 * max(durationSeconds, 0) * 1.1)
    }
}

/// ما يعرفه التطبيق عند اختيار الوضع. القياس لا يخرج من الجهاز.
public struct ProxyContext: Equatable, Sendable {
    public enum Network: Equatable, Sendable {
        /// Wi‑Fi أو سلكي بلا وضع البيانات المنخفضة.
        case unmetered
        /// خلوي أو نقطة اتصال (مكلف).
        case expensive
        /// وضع البيانات المنخفضة في النظام.
        case constrained
        case offline
    }

    public var isVideo: Bool
    public var durationSeconds: Double
    public var priority: Priority
    public var network: Network
    public var lowPowerMode: Bool
    /// 0…1، أو `nil` إن تعذّرت القراءة.
    public var batteryLevel: Double?
    public var freeBytes: Int64?

    public init(isVideo: Bool, durationSeconds: Double, priority: Priority, network: Network, lowPowerMode: Bool, batteryLevel: Double?, freeBytes: Int64?) {
        self.isVideo = isVideo
        self.durationSeconds = durationSeconds
        self.priority = priority
        self.network = network
        self.lowPowerMode = lowPowerMode
        self.batteryLevel = batteryLevel
        self.freeBytes = freeBytes
    }
}

/// اختيار الوضع تلقائيًا كما في جدول الخطة؛ المراسل يستطيع تغييره قبل الرفع.
public enum ProxyPolicy {
    /// مقطع أقصر من هذا يُرفع أصله مباشرة: النسخة لا توفّر ما يستحق زمن تحضيرها.
    public static let shortClipSeconds: Double = 30
    public static let lowBattery: Double = 0.2

    public static func suggest(_ c: ProxyContext) -> ProxyChoice {
        guard c.isVideo, c.durationSeconds >= shortClipSeconds else { return .originalOnly }
        // الترميز يستهلك البطارية: بطارية منخفضة أو وضع توفير الطاقة → الأصل فقط.
        if c.lowPowerMode || (c.batteryLevel.map { $0 < lowBattery } ?? false) { return .originalOnly }
        let choice: ProxyChoice
        switch c.network {
        case .constrained, .offline: choice = .urgent
        case .expensive: choice = c.priority == .urgent ? .urgent : .normal
        case .unmetered: choice = c.priority == .urgent ? .urgent : .originalOnly
        }
        return fits(choice, c) ? choice : (fits(.urgent, c) ? .urgent : .originalOnly)
    }

    /// مساحة كافية للنسخة مع هامش يساويها (ملف مؤقت للكاتب).
    static func fits(_ choice: ProxyChoice, _ c: ProxyContext) -> Bool {
        guard let preset = choice.preset else { return true }
        guard let free = c.freeBytes else { return true }
        return free > preset.estimatedBytes(durationSeconds: c.durationSeconds) * 2
    }
}

/// ما تنتجه النسخة: مسار الملف، و`start_pts` الأصل بالميكروثانية (يُكتب أيضًا في بيانات الحاوية)، ومدتها.
public struct ProxyResult: Equatable, Sendable {
    public let url: URL
    public let sourceStartPtsUs: Int64
    public let durationSeconds: Double
    public let width: Int
    public let height: Int
}

public enum ProxyError: Error, Equatable, Sendable {
    case unsupported, noVideoTrack, cancelled, failed(String)
}

/// يحضّر النسخة الخفيفة على الجهاز. التنفيذ الفعلي بـ AVFoundation على منصات Apple؛ على Linux لا شيء.
public protocol ProxyTranscoder: Sendable {
    func makeProxy(source: URL, preset: ProxyPreset, output: URL) async throws -> ProxyResult
}

/// مفتاح بيانات الحاوية الذي يحمل `start_pts` الأصل (ADR 0075).
public let proxyStartPtsMetadataKey = "net.palpost.posthistory.source_start_pts_us"

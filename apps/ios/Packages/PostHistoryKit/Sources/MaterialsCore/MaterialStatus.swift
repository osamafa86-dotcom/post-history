import Foundation
import PostHistoryAPI

/// ما يراه المراسل عن مادته: الحالات الثلاث مستقلة كما في العقد، لكلٍّ مفتاح نص ونبرة؛ لا تُدمج في حقل واحد.
public struct MaterialStatus: Equatable, Sendable {
    public enum Tone: String, Sendable { case neutral, progress, good, attention, bad }
    public struct Badge: Equatable, Sendable {
        /// مفتاح في `Localizable.xcstrings`.
        public var labelKey: String
        public var tone: Tone
    }

    public var technical: Badge
    public var editorial: Badge
    public var rights: Badge
    /// رقم إيصال الأصل إن صدر، وإلا إيصال أي ملف آخر.
    public var receiptNumber: String?

    public init(_ m: Material) {
        technical = Self.badge(m.technicalState)
        editorial = Self.badge(m.editorialState)
        rights = Self.badge(m.rightsState)
        let withReceipt = m.files.filter { !($0.receiptNumber ?? "").isEmpty }
        receiptNumber = (withReceipt.first { $0.kind == .original } ?? withReceipt.first)?.receiptNumber
    }

    static func badge(_ s: TechnicalState) -> Badge {
        switch s {
        case .pending: return Badge(labelKey: "material.technical.pending", tone: .neutral)
        case .proxyReceived: return Badge(labelKey: "material.technical.proxyReceived", tone: .progress)
        case .originalReceived: return Badge(labelKey: "material.technical.originalReceived", tone: .progress)
        case .verified: return Badge(labelKey: "material.technical.verified", tone: .good)
        case .failed: return Badge(labelKey: "material.technical.failed", tone: .bad)
        default: return Badge(labelKey: "material.state.unknown", tone: .neutral)
        }
    }

    static func badge(_ s: EditorialState) -> Badge {
        switch s {
        case .inbox: return Badge(labelKey: "material.editorial.inbox", tone: .neutral)
        case .acknowledged: return Badge(labelKey: "material.editorial.acknowledged", tone: .progress)
        case .reviewing: return Badge(labelKey: "material.editorial.reviewing", tone: .progress)
        case .needsChanges: return Badge(labelKey: "material.editorial.needsChanges", tone: .attention)
        case .accepted: return Badge(labelKey: "material.editorial.accepted", tone: .good)
        case .inProduction: return Badge(labelKey: "material.editorial.inProduction", tone: .good)
        case .finalReview: return Badge(labelKey: "material.editorial.finalReview", tone: .good)
        case .published: return Badge(labelKey: "material.editorial.published", tone: .good)
        case .rejected: return Badge(labelKey: "material.editorial.rejected", tone: .bad)
        default: return Badge(labelKey: "material.state.unknown", tone: .neutral)
        }
    }

    static func badge(_ s: RightsState) -> Badge {
        switch s {
        case .unknown: return Badge(labelKey: "material.rights.unknown", tone: .neutral)
        case .documented: return Badge(labelKey: "material.rights.documented", tone: .progress)
        case .sellable: return Badge(labelKey: "material.rights.sellable", tone: .good)
        case .blocked: return Badge(labelKey: "material.rights.blocked", tone: .bad)
        case .withdrawn: return Badge(labelKey: "material.rights.withdrawn", tone: .bad)
        default: return Badge(labelKey: "material.state.unknown", tone: .neutral)
        }
    }

    /// كل مفاتيح النصوص الممكنة؛ اختبار يتأكد أن لكلٍّ ترجمة عربية وإنجليزية.
    public static var allLabelKeys: [String] {
        let t = TechnicalState.allCases.map { badge($0).labelKey }
        let e = EditorialState.allCases.map { badge($0).labelKey }
        let r = RightsState.allCases.map { badge($0).labelKey }
        return Array(Set(t + e + r)).sorted()
    }
}

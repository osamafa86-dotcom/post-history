import Foundation
import PostHistoryAPI

/// الخط الزمني لمادة (المواصفة A4): ثلاثة مسارات مستقلة بلا دمج، مرتبة تنازليًا، مع التصفية بمسار واحد.
public struct MaterialTimeline: Equatable, Sendable {
    public let events: [TransitionRecord]

    public init(_ records: [TransitionRecord]) {
        events = records.filter { $0.track != .unknownDefaultOpenApi }.sorted { $0.occurredAt > $1.occurredAt }
    }

    public func filtered(_ track: TransitionRecord.Track?) -> [TransitionRecord] {
        guard let track else { return events }
        return events.filter { $0.track == track }
    }

    /// آخر ملاحظة من المشرف: أحدث انتقال تحريري إلى «تحتاج تعديلًا» بسبب غير فارغ، ما دامت المادة في تلك الحالة.
    public func supervisorNote(for material: Material) -> TransitionRecord? {
        guard material.editorialState == .needsChanges else { return nil }
        return events.first { $0.track == .editorial && $0.to == EditorialState.needsChanges.rawValue && !$0.reason.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    /// مفتاح نص الحدث: الحالة التي انتقل إليها على مساره.
    public static func labelKey(_ r: TransitionRecord) -> String {
        switch r.track {
        case .technical: return MaterialStatus.badge(TechnicalState(rawValue: r.to) ?? .unknownDefaultOpenApi).labelKey
        case .editorial: return MaterialStatus.badge(EditorialState(rawValue: r.to) ?? .unknownDefaultOpenApi).labelKey
        case .rights: return MaterialStatus.badge(RightsState(rawValue: r.to) ?? .unknownDefaultOpenApi).labelKey
        default: return "material.state.unknown"
        }
    }
}

extension Material {
    /// «تحتاج إجراء»: طلب تعديل من المشرف، أو فشل فني.
    public var needsAction: Bool { editorialState == .needsChanges || technicalState == .failed }

    /// الإجراء الأساسي في البطاقة الموسّعة بحسب الحالة.
    public enum PrimaryAction: Equatable, Sendable { case replaceShot, showReceipt, none }

    public var primaryAction: PrimaryAction {
        if editorialState == .needsChanges { return .replaceShot }
        if editorialState == .published || rightsState == .sellable { return .none }
        if technicalState == .verified || technicalState == .originalReceived { return .showReceipt }
        return .none
    }

    /// ملف الأصل وإيصاله إن صدر.
    public var originalFile: MaterialFile? { files.first { $0.kind == .original } }
}

/// صياغة الإيصال: البصمة مختصرة (8 أحرف أول وآخر)، والحجم بوحدات مقروءة. الأرقام والبصمات تُعرض LTR دائمًا.
public enum ReceiptFormatting {
    public static func shortHash(_ sha256: String) -> String {
        let s = sha256.lowercased()
        guard s.count > 16 else { return s }
        return "\(s.prefix(8))…\(s.suffix(8))"
    }

    /// رابط المادة الداخلي في رمز QR: المعرّف وحده، يفتحه التطبيق أو الويب لمن له صلاحية فقط.
    public static func internalLink(materialId: UUID) -> String { "posthistory://materials/\(materialId.uuidString.lowercased())" }
}

import Foundation
import struct UploadCore.AccountScope

/// إيصالات تنتظر أصحابها (ADR 0093): إيصال يصل لحساب غير الداخل، أو والكل خارج، لا يُعرض بل ينتظر حتى يدخل صاحبه؛ والإيصال
/// المعروض عند الخروج يعود إلى الانتظار، فلا يراه من يدخل بعده. في الذاكرة وحدها: إن أُغلق التطبيق قبل أن يعود صاحبه، فإيصال
/// الإرسالة يُعرض عند دخوله من سجلها إن بقي (`SendBatchLedger`)، وإيصال المادة من «عرض الإيصال» في تفاصيلها.
public struct ReceiptInbox<Target: Equatable & Sendable>: Equatable, Sendable {
    private struct Entry: Equatable, Sendable {
        var target: Target
        var owner: UUID?
    }

    private var waiting: [Entry] = []

    public init() {}

    /// عدد ما ينتظر، لكل الحسابات (للاختبارات؛ لا يُعرض).
    public var count: Int { waiting.count }

    /// إيصال وصل: يُعاد ليُعرض الآن إن كان للحساب الداخل، وإلا ينتظر صاحبه (`nil`).
    public mutating func arrive(_ target: Target, owner: UUID?, scope: AccountScope) -> Target? {
        if scope.owns(owner) { return target }
        hold(target, owner: owner)
        return nil
    }

    /// ينتظر صاحبه: إيصال لم يُعرض بعد، أو كان معروضًا عند الخروج. لا يتكرر.
    public mutating func hold(_ target: Target, owner: UUID?) {
        guard !waiting.contains(where: { $0.target == target }) else { return }
        waiting.append(Entry(target: target, owner: owner))
    }

    /// أقدم إيصال ينتظر الحساب الداخل، ويخرج من الانتظار (بعد الدخول، أو بعد إغلاق إيصال معروض). لا شيء لغيره.
    public mutating func next(for scope: AccountScope) -> Target? {
        guard let i = waiting.firstIndex(where: { scope.owns($0.owner) }) else { return nil }
        return waiting.remove(at: i).target
    }

    /// المسح الطارئ والإبطال: لا يبقى إيصال ينتظر أحدًا.
    public mutating func removeAll() { waiting = [] }
}

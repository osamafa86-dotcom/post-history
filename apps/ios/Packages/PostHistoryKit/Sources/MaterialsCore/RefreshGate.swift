import Foundation

/// باب واحد لتحديث تطلبه الشاشة عند ظهورها أو تغيّر حالتها (الرئيسية: `GET /auth/me` ثم `GET /materials`):
/// - طلب واحد في الطريق: من يطلب أثناءه ينتظره ولا يرسل غيره، مهما تعددت الدعوات في الإطار نفسه.
/// - لا طلب والنتيجة طازجة (`freshFor` بعد آخر نجاح)، فارغةً كانت القائمة أو لا.
/// - بعد كل فشل متتالٍ مهلة أطول (`backoff`) لا يُرسل قبلها شيء إلا بطلب المراسل (`.user`).
/// - الإلغاء ليس فشلًا ولا نجاحًا. والطلب في مهمة يملكها الباب لا مهمة الشاشة: اختفاء الشاشة وعودتها لا يلغيه ولا يعيده.
///
/// بناء TestFlight 13: كانت مهمة الرئيسية (`.task`) تطلب الزوج في كل ظهور بلا شرط (و«موادي» الفارغة لا تُعدّ طازجة أبدًا)، والزوج
/// نفسه ينشر حالة تراقبها الرئيسية (اسم العمل يُكتب ولو لم يتغيّر، و«جارٍ التحميل» مرتين)؛ فكل دورة أطلقت التي بعدها، وأرسل
/// التطبيق نحو 76 زوجًا في ثانية. الباب يكسر الحلقة أيًّا كان ما يعيد الظهور: الدورة الثانية تجد النتيجة طازجة فلا تطلب ولا تنشر.
public actor RefreshGate {
    public struct Policy: Equatable, Sendable {
        /// بعد نجاح: لا طلب بـ `.ifStale` قبل انقضاء هذه المدة.
        public var freshFor: TimeInterval
        /// المهل بعد كل فشل متتالٍ بالترتيب؛ الأخيرة تتكرر.
        public var backoff: [TimeInterval]

        public init(freshFor: TimeInterval = 30, backoff: [TimeInterval] = [2, 5, 15, 30, 60, 120]) {
            self.freshFor = freshFor
            self.backoff = backoff.isEmpty ? [0] : backoff
        }

        /// المهلة بعد `failures` فشلًا متتاليًا (1 فأكثر).
        public func delay(afterFailures failures: Int) -> TimeInterval {
            backoff[min(max(failures, 1), backoff.count) - 1]
        }
    }

    public enum Demand: Equatable, Sendable {
        /// ظهور شاشة أو تغيّر حالة: لا طلب والنتيجة طازجة، ولا في مهلة بعد فشل.
        case ifStale
        /// استطلاع دوري: لا ينظر إلى الطزاجة، ويحترم مهلة الفشل.
        case poll
        /// طلب المراسل (السحب للتحديث، زرّ «تحديث»): يُرسل الآن، إلا أن يكون طلب في الطريق فينتظره.
        case user
    }

    public enum Outcome: Equatable, Sendable {
        /// أُرسل هذا الطلب ونجح.
        case fetched
        /// أُرسل هذا الطلب وفشل؛ بدأت المهلة.
        case failed
        /// أُلغي الطلب (ليس فشلًا ولا نجاحًا).
        case cancelled
        /// طلب في الطريق انتظره هذا ولم يرسل غيره.
        case joined
        /// لا طلب: آخر نجاح طازج.
        case fresh
        /// لا طلب: في مهلة بعد فشل.
        case backingOff
        /// أُعيد ضبط الباب أثناء الطلب (خروج، مسح، إبطال): نتيجته لا تُحسب.
        case dropped
    }

    private let policy: Policy
    private let now: @Sendable () -> Date
    private var inFlight: (id: UInt64, task: Task<Outcome, Never>)?
    private var nextId: UInt64 = 0
    /// يرتفع مع `reset()`: طلب بدأ قبله لا يكتب طزاجة ولا مهلة بعده.
    private var epoch: UInt64 = 0
    private var lastSuccess: Date?
    private var failures = 0
    private var retryAt: Date?
    /// كم طلبًا أُرسل فعلًا منذ الإنشاء (للاختبارات).
    public private(set) var sent = 0

    public init(policy: Policy = Policy(), now: @escaping @Sendable () -> Date = { Date() }) {
        self.policy = policy
        self.now = now
    }

    /// متى يُسمح بطلب بعد فشل (`nil` بلا مهلة جارية).
    public var retryAfter: Date? { retryAt }
    public var consecutiveFailures: Int { failures }

    /// يرسل `work` إن كان أوانه، وإلا يعيد سبب الامتناع. `work` يرمي عند الفشل (بعد أن يطبّق ما يطبّقه)، والإلغاء يُعرف بـ
    /// `LoadOutcome.isCancellation`.
    @discardableResult
    public func run(_ demand: Demand = .ifStale, _ work: @escaping @Sendable () async throws -> Void) async -> Outcome {
        if let running = inFlight {
            _ = await running.task.value
            return .joined
        }
        let start = now()
        if demand != .user, let retryAt, start < retryAt { return .backingOff }
        if demand == .ifStale, let lastSuccess, start.timeIntervalSince(lastSuccess) < policy.freshFor { return .fresh }
        let started = epoch
        nextId &+= 1
        let id = nextId
        sent += 1
        let task = Task<Outcome, Never> {
            do {
                try await work()
                return .fetched
            } catch {
                return LoadOutcome.isCancellation(error) ? .cancelled : .failed
            }
        }
        inFlight = (id, task)
        let outcome = await task.value
        if inFlight?.id == id { inFlight = nil }
        guard started == epoch else { return .dropped }
        switch outcome {
        case .fetched:
            lastSuccess = now()
            failures = 0
            retryAt = nil
        case .failed:
            failures += 1
            retryAt = now().addingTimeInterval(policy.delay(afterFailures: failures))
        default:
            break
        }
        return outcome
    }

    /// الخروج والمسح والإبطال: لا طزاجة ولا مهلة تُورَث لمن يدخل بعده، وما في الطريق تسقط نتيجته عند الباب.
    public func reset() {
        epoch &+= 1
        inFlight = nil
        lastSuccess = nil
        failures = 0
        retryAt = nil
    }
}

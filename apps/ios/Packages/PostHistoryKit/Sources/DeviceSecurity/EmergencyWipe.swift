import Foundation

/// نتيجة خطوة مسح واحدة. الاسم معرّف ثابت (لا مسار)؛ يصلح للعرض وللبطاقة الميدانية.
public struct WipeOutcome: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        case wiped(items: Int)
        /// لم يكن هناك ما يُمسح.
        case absent
        case failed(String)
    }
    public var step: String
    public var status: Status
    public init(step: String, status: Status) { self.step = step; self.status = status }
}

public struct WipeReport: Equatable, Sendable {
    public var outcomes: [WipeOutcome]
    public var startedAt: Date
    public var finishedAt: Date
    public var allClean: Bool { outcomes.allSatisfy { if case .failed = $0.status { return false } else { return true } } }
    public init(outcomes: [WipeOutcome], startedAt: Date, finishedAt: Date) {
        self.outcomes = outcomes; self.startedAt = startedAt; self.finishedAt = finishedAt
    }
}

/// خطوة مسح: اسم ثابت وعمل يعيد عدد ما مُسح. الأخطاء لا توقف الخطوات التالية.
public struct WipeStep: Sendable {
    public var name: String
    public var run: @Sendable () async throws -> Int
    public init(name: String, run: @escaping @Sendable () async throws -> Int) { self.name = name; self.run = run }
}

/// المسح الطارئ: ينفّذ الخطوات بالترتيب (أولًا ما يوقف النقل ويمحو الرموز، ثم الملفات)، ويجمع تقريرًا دون أن يسجّل شيئًا.
public struct EmergencyWipe: Sendable {
    public var steps: [WipeStep]
    public var now: @Sendable () -> Date

    public init(steps: [WipeStep], now: @escaping @Sendable () -> Date = { Date() }) { self.steps = steps; self.now = now }

    public func run() async -> WipeReport {
        let started = now()
        var outcomes: [WipeOutcome] = []
        for step in steps {
            do {
                let n = try await step.run()
                outcomes.append(WipeOutcome(step: step.name, status: n == 0 ? .absent : .wiped(items: n)))
            } catch {
                outcomes.append(WipeOutcome(step: step.name, status: .failed(String(describing: type(of: error)))))
            }
        }
        return WipeReport(outcomes: outcomes, startedAt: started, finishedAt: now())
    }
}

/// يمسح محتويات مجلدات (ويعيد إنشاءها فارغة إن طُلب) ومفاتيح إعدادات. لا يُعيد مسارات في أي خطأ.
public enum LocalDataWiper {
    public enum WipeError: Error { case removalFailed }

    /// يحذف كل ما داخل المجلد ويعيد عدد العناصر المحذوفة؛ المجلد الغائب = 0.
    @discardableResult
    public static func emptyDirectory(_ url: URL, recreate: Bool = true, fileManager: FileManager = .default) throws -> Int {
        guard fileManager.fileExists(atPath: url.path) else {
            if recreate { try fileManager.createDirectory(at: url, withIntermediateDirectories: true) }
            return 0
        }
        let items = try fileManager.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)
        var removed = 0
        var failed = false
        for item in items {
            do { try fileManager.removeItem(at: item); removed += 1 } catch { failed = true }
        }
        if failed { throw WipeError.removalFailed }
        if !recreate { try? fileManager.removeItem(at: url) }
        return removed
    }

    /// خطوة جاهزة لمجلد.
    public static func directoryStep(name: String, url: URL, recreate: Bool = true) -> WipeStep {
        WipeStep(name: name) { try emptyDirectory(url, recreate: recreate) }
    }

    /// خطوة لمفاتيح إعدادات (UserDefaults أو ما يماثله) تُحذف بالاسم؛ `keep` يُستثنى (مثل علامة أول تشغيل).
    public static func keyValueStep(name: String, keys: [String], keep: Set<String> = [], remove: @escaping @Sendable (String) -> Bool) -> WipeStep {
        WipeStep(name: name) { keys.filter { !keep.contains($0) }.reduce(0) { $0 + (remove($1) ? 1 : 0) } }
    }
}

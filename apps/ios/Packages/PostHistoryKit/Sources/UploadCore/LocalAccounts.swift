import Foundation

/// لمن تُعرض سجلات الرفع والإرسالات والإيصالات، وباسم من تُرسل طلبات الرفع المصادَق عليها (ADR 0093). الحساب يُعرف على الجهاز
/// بمعرّف محلي معتم (`LocalAccounts`)، لا ببريده ولا بمعرّفه على الخادم.
public struct AccountScope: Equatable, Sendable {
    /// الحساب الداخل الآن؛ `nil` بلا دخول.
    public var current: UUID?
    /// الحساب الوحيد الذي دخل على هذا الجهاز (منذ هذا الإصدار)؛ `nil` إن لم يدخل أحد أو دخل أكثر من حساب.
    public var sole: UUID?

    public init(current: UUID? = nil, sole: UUID? = nil) {
        self.current = current
        self.sole = sole
    }

    /// السجل لمالكه `owner` يخص الحساب الداخل: يُعرض له وحده، وتُرسل طلباته المصادَق عليها باسمه وحده. السجل بلا مالك (من إصدار
    /// سابق) للحساب الداخل إن كان الوحيد الذي دخل على الجهاز، وإلا فلا لأحد: يبقى مخفيًا، ولا يطلب باسم حساب قد لا يملكه.
    public func owns(_ owner: UUID?) -> Bool {
        guard let current else { return false }
        if let owner { return owner == current }
        return sole == current
    }

    /// سجلات الحساب الداخل وحده؛ ما لغيره لا يظهر منه عنوان ولا مصغّرة ولا عدد.
    public func visible(_ records: [UploadRecord]) -> [UploadRecord] {
        records.filter { owns($0.ownerAccount) }
    }

    /// أصول الحساب الداخل التي لم تنتهِ بعد: تُكمل في الخلفية بعد الخروج، فيسأل الخروج أولًا إن وُجد منها شيء.
    public func pendingOriginals(_ records: [UploadRecord]) -> Int {
        records.filter { $0.kind == .original && !$0.phase.isTerminal && owns($0.ownerAccount) }.count
    }
}

/// الحسابات التي دخلت على هذا الجهاز (ADR 0093): لكل حساب معرّف محلي عشوائي يُكتب في سجلات الرفع والإرسالات بدل بريده أو معرّفه
/// على الخادم. المفتاح بصمة SHA-256 لمعرّف الخادم مع ملح عشوائي من الجهاز، فلا يُقرأ منه الحساب. يمحوه المسح الطارئ مع حالة الرفع،
/// ولا يمحوه الخروج: عليه يقوم «من دخل على الجهاز» لسجلات الإصدارات السابقة. ومن دخل قبل هذا الإصدار وحده لا يُعرف.
public struct LocalAccounts: Codable, Equatable, Sendable {
    private var salt: String
    private var ids: [String: UUID]

    public init(salt: String = UUID().uuidString) {
        self.salt = salt
        ids = [:]
    }

    public var count: Int { ids.count }

    /// الحساب الوحيد الذي دخل على الجهاز، إن كان واحدًا.
    public var sole: UUID? { ids.count == 1 ? ids.values.first : nil }

    /// المعرّف المحلي للحساب، ويُسجَّل إن دخل أول مرة.
    public mutating func register(serverAccount: UUID) -> UUID {
        let key = digest(serverAccount)
        if let known = ids[key] { return known }
        let fresh = UUID()
        ids[key] = fresh
        return fresh
    }

    /// المعرّف المحلي لحساب دخل من قبل، وإلا `nil`.
    public func localId(serverAccount: UUID) -> UUID? { ids[digest(serverAccount)] }

    /// النطاق والحساب `serverAccount` داخل (أو `nil` بلا دخول).
    public func scope(signedIn serverAccount: UUID?) -> AccountScope {
        AccountScope(current: serverAccount.flatMap { localId(serverAccount: $0) }, sole: sole)
    }

    private func digest(_ account: UUID) -> String {
        SHA256Stream.hex(of: Data("\(salt):\(account.uuidString.lowercased())".utf8))
    }
}

/// ملف الحسابات بحماية سجلات الرفع نفسها. لا امتداد `.json` له لأن مخزن الحالة يقرأ كل JSON في مجلده سجلَّ رفع.
public final class LocalAccountsStore: @unchecked Sendable {
    public let fileURL: URL

    public init(fileURL: URL) { self.fileURL = fileURL }

    /// السجل كما على القرص؛ سجل فارغ إن لم يوجد الملف (أول تشغيل، أو بعد المسح الطارئ)، و`nil` إن وُجد ولم يُقرأ (الهاتف مقفل في
    /// إطلاق خلفي): لا يُكتب حينها سجل جديد فوق القديم.
    public func load() -> LocalAccounts? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return LocalAccounts() }
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(LocalAccounts.self, from: data)
    }

    public func save(_ accounts: LocalAccounts) throws {
        try JSONEncoder().encode(accounts).write(to: fileURL, options: UploadFileProtection.writingOptions)
    }
}

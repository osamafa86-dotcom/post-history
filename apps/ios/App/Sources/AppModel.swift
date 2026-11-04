import AuthCore
import DeviceAttestation
import DeviceSecurity
import Foundation
import MaterialsCore
import NotificationsCore
import PostHistoryAPI
import SwiftUI
import UploadCore

/// تركيب الطبقات: عميل API مولَّد بمعترض الهوية، وجلسة الهوية فوق Keychain.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case loading, signedOut, signedIn(StoredSession), revoked(at: Date, report: WipeReport), wiped(WipeReport) }

    @Published private(set) var phase: Phase = .loading
    /// اسم العمل للتحية في الرئيسية (`GET /auth/me`)؛ يبقى في الذاكرة وحدها ولا يُكتب على القرص.
    @Published private(set) var workName: String?
    /// من يرسل من التطبيق (`SendAccess`، الخطة وADR 0011 و0088): أدوار الداخل من `GET /auth/me`، وقبل وصوله من الجلسة المحفوظة
    /// (أدوارها من الخادم). `nil` بلا دخول. حساب بلا دور مراسل لا تُعرض له شاشة الإرسال، بل سطر يقول ذلك.
    @Published private(set) var sendAccess: SendAccess?
    /// `GET /auth/me` بباب واحد (`RefreshGate`، مختبر): طلب واحد في الطريق، ولا طلب والنتيجة طازجة، ومهلة متزايدة بعد كل فشل.
    /// ظهور الرئيسية المتكرر لا يعيد الطلب (بناء TestFlight 13: نحو 76 زوجًا مع `GET /materials` في ثانية).
    private let profileGate = RefreshGate()

    /// الإرسال معروض للداخل. قبل أن تُعرف أدواره (لا يحدث وهو داخل: الجلسة تحملها) يبقى معروضًا، والخادم يرفض بالرمز.
    var canSend: Bool { sendAccess?.canSend ?? true }

    let auth: AuthSession
    /// إعداد العميل لكل المسارات المصادَق عليها (يضيف Bearer ويحدّث عند 401).
    let api: PostHistoryAPIAPIConfiguration
    let settings = AppSettings()
    let lock = AppLockModel()
    let uploads: UploadQueueModel
    let materials: MyMaterialsModel
    let notifications: NotificationsModel
    let push: PushRegistrar
    /// ما يتذكّره التطبيق للمراسل بين إرسال وآخر (المكان واسم الظهور ووسومه السابقة، ADR 0088).
    let memory = ReporterMemoryStore(fileURL: UploadServices.shared.memoryFile)
    /// الحسابات التي دخلت على هذا الجهاز بمعرّفات محلية معتمة (ADR 0093)؛ يمحوها المسح الطارئ مع حالة الرفع، ولا يمحوها الخروج.
    private let accountsStore = LocalAccountsStore(fileURL: UploadServices.shared.accountsFile)
    /// آخر ما قُرئ منها؛ `nil` إن تعذّرت القراءة (الهاتف مقفل في إطلاق خلفي)، فتُعاد حين يُفتح.
    private var accounts: LocalAccounts?
    private var authWatcher: Task<Void, Never>?

    init(store: any TokenStore = KeychainTokenStore(), baseURL: String = AppConfiguration.apiBaseURL) {
        // Keychain يبقى بعد حذف التطبيق: أول تشغيل بعد تثبيت جديد يمسح جلسة مستخدم سابق (العلامة تُحذف مع التطبيق).
        if !UserDefaults.standard.bool(forKey: "hasLaunchedBefore") {
            try? store.clear()
            try? KeychainUploadSecretStore().removeAll()
            // معرّف مفتاح App Attest من تثبيت سابق (Keychain يبقى بعد الحذف) لم يعد صالحًا؛ يُسجَّل مفتاح جديد عند أول رفع.
            try? KeychainAttestationKeyStore().removeKeyId()
            UserDefaults.standard.set(true, forKey: "hasLaunchedBefore")
        }
        // مسارات /auth/* بلا معترض كي لا يدخل التحديث في حلقة.
        let plain = PostHistoryAPIAPIConfiguration.noCache(basePath: baseURL)
        let auth = AuthSession(store: store, gateway: APIAuthGateway(configuration: plain))
        self.auth = auth
        let api = PostHistoryAPIAPIConfiguration.noCache(basePath: baseURL, interceptor: AuthInterceptor(auth: auth))
        self.api = api
        // نواة الرفع فوق الجلسة الخلفية المشتركة؛ تُستأنف السجلات غير المكتملة عند كل إطلاق.
        self.uploads = UploadQueueModel(engine: try! UploadServices.shared.makeEngine(api: api), settings: settings)
        self.materials = MyMaterialsModel(feed: MaterialsFeed(api: GeneratedMaterialsListAPI(configuration: api)),
                                          transitions: { try await MaterialsAPI.listTransitions(id: $0, apiConfiguration: api).items },
                                          // رابط المشتق الموقّع (≤ 10 دقائق، no-store) يُطلب لحظة العرض ولا يُحفظ (ADR 0089).
                                          downloadURL: { try await MaterialsAPI.getMaterialFileDownloadUrl(id: $0, fileId: $1, apiConfiguration: api) })
        self.notifications = NotificationsModel(feed: NotificationsFeed(api: GeneratedNotificationsListAPI(configuration: api)))
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        self.push = PushRegistrar(api: GeneratedPushDevicesAPI(configuration: api), ids: KeychainInstallationIdStore(), appVersion: appVersion)
        PushBridge.shared.registrar = push
        PushBridge.shared.onOpen = { [weak self] route in Task { await self?.notifications.openFromPush(route) } }
        Task { await self.restore() }
    }

    func restore() async {
        let session = await auth.session
        // الأدوار قبل الرئيسية: لا يظهر زرّ الإرسال لحظةً لحساب لا يرسل.
        sendAccess = session.map { SendAccess(roles: $0.roles.map(\.name)) }
        phase = session.map(Phase.signedIn) ?? .signedOut
        // النطاق قبل أن تستأنف النواة السجلات: لا طلب باسم غير صاحبه من أول خطوة.
        await applyAccountScope(signedIn: signedInAccount)
        if case .signedIn = phase { uploads.start(); await startPush() }
        watchAuth()
    }

    /// الهاتف فُتح: سجل الحسابات الذي تعذّرت قراءته في إطلاق خلفي يُقرأ الآن، فيظهر للداخل ما له وتكمل النواة باسمه.
    func becameActive() async {
        guard accounts == nil else { return }
        await applyAccountScope(signedIn: signedInAccount)
    }

    private var signedInAccount: UUID? {
        if case .signedIn(let session) = phase { return session.userId }
        return nil
    }

    /// من الداخل الآن (ADR 0093): يُسجَّل الحساب إن دخل أول مرة بمعرّف محلي معتم، ثم ترى الشاشات سجلاته وحده وتطلب النواة باسمه
    /// وحده. سجل حسابات لا يُقرأ نطاقٌ بلا أحد: لا يُعرض شيء ولا يُطلب باسم أحد حتى يُقرأ.
    private func applyAccountScope(signedIn: UUID?) async {
        if accounts == nil { accounts = accountsStore.load() }
        var scope = AccountScope()
        if var known = accounts {
            if let signedIn, known.localId(serverAccount: signedIn) == nil {
                _ = known.register(serverAccount: signedIn)
                try? accountsStore.save(known)
                accounts = known
            }
            scope = known.scope(signedIn: signedIn)
        }
        await uploads.setScope(scope)
    }

    /// إبطال عن بُعد (SEC-01): رُفض رمز التحديث ← يُمحى كل ما يمحوه المسح الطارئ (ADR 0113، تعديل لنطاق ADR 0009 §3): مهام الرفع
    /// الخلفية ورموزها وحالتها، والأصول المستوردة، والمسودات، ومعرّف مفتاح App Attest، والذاكرة المؤقتة وما في tmp؛ ثم شاشة
    /// «أُبطلت الجلسة». الإبطال قد يكون بعد بلاغ فقد الهاتف، فلا يبقى عليه ما يُقرأ ممن يحمله.
    private func watchAuth() {
        authWatcher?.cancel()
        authWatcher = Task { [weak self] in
            guard let self else { return }
            for await event in await auth.events() {
                guard case .sessionRevoked(let at) = event else { continue }
                let report = await wipeLocally(revokeRemote: false)
                phase = .revoked(at: at, report: report)
                await applyAccountScope(signedIn: nil)
            }
        }
    }

    /// المسح الطارئ (SEC-01): محلي فقط وبلا اتصال؛ يوقف النقل ويمحو الرموز والحالة والأجزاء والأصول المستوردة والمصغّرات وذاكرة الصور،
    /// ثم يعيد التطبيق إلى شاشة البداية. لا يُسجَّل شيء.
    func emergencyWipe() async {
        let report = await wipeLocally(revokeRemote: true)
        phase = .wiped(report)
        await applyAccountScope(signedIn: nil)
    }

    /// خطوات المسح كلها، للمسح الطارئ وللإبطال عن بُعد معًا (ADR 0113): قائمة واحدة فلا تنقص إحداهما عن الأخرى. `revokeRemote`:
    /// المسح الطارئ يطلب من الخادم إبطال كل الجلسات أولًا؛ في الإبطال قد أبطلها الخادم أصلًا.
    private func wipeLocally(revokeRemote: Bool) async -> WipeReport {
        // التشغيل يتوقف أولًا ويُمحى رابطه ومعايناته، قبل محو الملفات التي قد يقرؤها.
        PlaybackCenter.shared.stopAll()
        uploads.cancelLightCopies()
        let services = UploadServices.shared
        let engine = uploads.engine
        let auth = self.auth
        let push = self.push
        var steps: [WipeStep] = []
        if revokeRemote {
            // قرار المنسّق: إبطال كل الجلسات على الخادم بأفضل جهد (≤3 ث) قبل المحو؛ لا ينتظره المحو ولا يفشل بسببه.
            steps.append(WipeStep(name: "revoke_remote") { await auth.revokeEverywhereBestEffort(timeout: 3) ? 1 : 0 })
        }
        steps += [
            WipeStep(name: "uploads") { await engine.wipeAll() },
            // معرّف التثبيت يُنسى محليًا (بلا اتصال)؛ إلغاء الجهاز على الخادم يتبع إبطال الجلسات أعلاه.
            WipeStep(name: "installation_id") { await push.forgetLocally(); return 1 },
            // ما على شاشة القفل ومركز الإشعارات والشارة.
            WipeStep(name: "delivered_notifications") { await NotificationTraceWiper.wipe(SystemNotificationCenterTraces()) },
            WipeStep(name: "session") { await auth.forgetLocally(); return 1 },
            WipeStep(name: "upload_tokens") { try KeychainUploadSecretStore().removeAll(); return 1 },
            // معرّف مفتاح App Attest معرّف تثبيت: يُحذف فيُسجَّل مفتاح جديد بعد الدخول التالي.
            WipeStep(name: "attestation_key") { try KeychainAttestationKeyStore().removeKeyId(); return 1 },
            LocalDataWiper.directoryStep(name: "upload_state", url: services.stateDirectory),
            LocalDataWiper.directoryStep(name: "chunks", url: services.chunksDirectory),
            LocalDataWiper.directoryStep(name: "imported_originals", url: services.uploadsDirectory),
            LocalDataWiper.directoryStep(name: "drafts", url: services.draftsDirectory),
            // المكان المتذكَّر واسم الظهور والوسوم السابقة (قد تحوي أسماء حساسة، ADR 0086)، والإرسالات الأخيرة بعناوينها.
            LocalDataWiper.directoryStep(name: "reporter_memory", url: services.memoryDirectory),
            LocalDataWiper.directoryStep(name: "send_batches", url: services.batchesDirectory),
            LocalDataWiper.directoryStep(name: "caches", url: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]),
            LocalDataWiper.directoryStep(name: "temporary", url: FileManager.default.temporaryDirectory),
            WipeStep(name: "url_cache") { URLCache.shared.removeAllCachedResponses(); return 1 },
            LocalDataWiper.keyValueStep(name: "defaults", keys: ["deleteLocalAfterReceipt", AppSettings.localCopyHandledKey], keep: ["hasLaunchedBefore"]) { key in
                UserDefaults.standard.removeObject(forKey: key); return true
            },
        ]
        let report = await EmergencyWipe(steps: steps).run()
        ThumbnailCache.shared.clear()
        workName = nil
        sendAccess = nil
        await profileGate.reset()
        services.recreateProtectedDirectories()
        settings.reload()
        lock.reset()
        uploads.reloadDrafts()
        uploads.forgetBatches()
        uploads.forgetWaitingReceipts()
        // سجل الحسابات مُحي مع حالة الرفع: لا أحد دخل على الجهاز بعد المسح.
        accounts = nil
        await uploads.refresh()
        await materials.clear()
        await notifications.clear()
        return report
    }

    func acknowledgeAndSignIn() { phase = .signedOut }

    /// اسم التحية وأدوار الداخل عند ظهور الرئيسية، بباب واحد (`profileGate`): ظهورٌ متكرر لا يعيد الطلب ما دامت النتيجة طازجة، ولا
    /// يرسله في مهلة بعد فشل. كان كل ظهور يطلب ثم يكتب `workName` (ولو لم يتغيّر، و`nil` لطلب أُلغي)، والكتابة تعيد رسم الرئيسية التي
    /// تطلب من جديد. بلا شبكة تبقى التحية بلا اسم والأدوار من الجلسة.
    func loadProfile() async {
        guard case .signedIn = phase else { return }
        await profileGate.run(.ifStale) { [weak self] in
            guard let self else { return }
            try await self.fetchProfile()
        }
    }

    /// يرمي إن فشل الطلب (للمهلة)، ولا يكتب إلا ما تغيّر: كل نشر يعيد رسم الرئيسية.
    private func fetchProfile() async throws {
        let me = try await AuthAPI.getMe(apiConfiguration: api)
        // ردّ وصل بعد الخروج أو بعد دخول حساب آخر لا يُكتب لغير صاحبه.
        guard case .signedIn(let session) = phase, session.userId == me.userId else { return }
        let name = me.workName.flatMap { $0.isEmpty ? nil : $0 }
        if workName != name { workName = name }
        let access = SendAccess(roles: me.roles.map(\.name))
        if sendAccess != access { sendAccess = access }
    }

    /// بعد الدخول: الإذن ثم APNs، والتسجيل لدى الخادم حين يصل الرمز.
    private func startPush() async {
        await push.didSignIn()
        await PushBridge.shared.requestAuthorizationAndRegister()
    }

    func login(email: String, password: String, totpCode: String) async throws {
        let session = try await auth.login(email: email, password: password, totpCode: totpCode.isEmpty ? nil : totpCode)
        // حساب جديد يطلب ملفه الآن: لا طزاجة ولا مهلة من حساب قبله.
        await profileGate.reset()
        sendAccess = SendAccess(roles: session.roles.map(\.name))
        phase = .signedIn(session)
        await applyAccountScope(signedIn: session.userId)
        uploads.start()
        await startPush()
    }

    func logout(allSessions: Bool) async {
        // التشغيل يتوقف ويُمحى رابطه قبل أي انتظار على الشبكة، كما في المسح والإبطال.
        PlaybackCenter.shared.stopAll()
        // الرموز تُمسح محليًا قبل الاتصال؛ فشل الشبكة لا يبقي الجلسة على الجهاز.
        await push.willSignOut()
        try? await auth.logout(allSessions: allSessions)
        // سجلات الرفع باقية وتكمل في الخلفية (قرار المنسّق، ADR 0093)، لكن لا يُعرض منها شيء حتى يدخل صاحبها، ولا تطلب النواة
        // باسم أحد؛ والإيصال المعروض يعود إلى انتظار صاحبه.
        await applyAccountScope(signedIn: nil)
        // لا يبقى لمراسل خرج مكانٌ ولا وسوم ولا مصغّرات، ولا إرسالاته بعناوينها وجواب حساسيتها (`send-batches.json`)، لمن يدخل
        // بعده على الهاتف نفسه؛ كما في الإبطال والمسح.
        memory.clear()
        uploads.forgetBatches()
        ThumbnailCache.shared.clear()
        workName = nil
        sendAccess = nil
        await profileGate.reset()
        await materials.clear()
        await notifications.clear()
        await NotificationTraceWiper.wipe(SystemNotificationCenterTraces())
        phase = .signedOut
    }
}

enum AppConfiguration {
    static var apiBaseURL: String {
        (Bundle.main.object(forInfoDictionaryKey: "PHAPIBaseURL") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "https://api.example.invalid/v1"
    }
}

extension AuthError {
    /// مفتاح الرسالة في موارد التطبيق (ar/en)؛ لا نص حرفي في الكود.
    var messageKey: LocalizedStringKey {
        switch self {
        case .notSignedIn, .sessionExpired: return "auth.error.sessionExpired"
        case .totpRequired: return "auth.error.totpRequired"
        case .unauthorized: return "auth.error.unauthorized"
        case .rateLimited: return "auth.error.rateLimited"
        case .validation: return "auth.error.validation"
        case .server: return "auth.error.server"
        case .transport: return "auth.error.transport"
        }
    }
}

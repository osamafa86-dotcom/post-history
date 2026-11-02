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
    enum Phase: Equatable { case loading, signedOut, signedIn(StoredSession), revoked(at: Date), wiped(WipeReport) }

    @Published private(set) var phase: Phase = .loading
    /// اسم العمل للتحية في الرئيسية (`GET /me`)؛ يبقى في الذاكرة وحدها ولا يُكتب على القرص.
    @Published private(set) var workName: String?

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
    /// الحسابات التي دخلت على هذا الجهاز بمعرّفات محلية معتمة (ADR 0091)؛ يمحوها المسح الطارئ مع حالة الرفع، ولا يمحوها الخروج.
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
        phase = await auth.session.map(Phase.signedIn) ?? .signedOut
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

    /// من الداخل الآن (ADR 0091): يُسجَّل الحساب إن دخل أول مرة بمعرّف محلي معتم، ثم ترى الشاشات سجلاته وحده وتطلب النواة باسمه
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

    /// إبطال عن بُعد (SEC-01): رُفض رمز التحديث ← تتوقف كل مهام الرفع الخلفية وتُمحى رموز الرفع وحالته، وتُعرض شاشة «أُبطلت الجلسة».
    private func watchAuth() {
        authWatcher?.cancel()
        authWatcher = Task { [weak self] in
            guard let self else { return }
            for await event in await auth.events() {
                guard case .sessionRevoked(let at) = event else { continue }
                PlaybackCenter.shared.stopAll()
                uploads.cancelLightCopies()
                _ = await uploads.engine.wipeAll()
                await uploads.refresh()
                uploads.forgetBatches()
                uploads.forgetWaitingReceipts()
                memory.clear()
                ThumbnailCache.shared.clear()
                workName = nil
                await materials.clear()
                await push.forgetLocally()
                await notifications.clear()
                await NotificationTraceWiper.wipe(SystemNotificationCenterTraces())
                phase = .revoked(at: at)
                await applyAccountScope(signedIn: nil)
            }
        }
    }

    /// المسح الطارئ (SEC-01): محلي فقط وبلا اتصال؛ يوقف النقل ويمحو الرموز والحالة والأجزاء والأصول المستوردة والمصغّرات وذاكرة الصور،
    /// ثم يعيد التطبيق إلى شاشة البداية. لا يُسجَّل شيء.
    func emergencyWipe() async {
        // التشغيل يتوقف أولًا ويُمحى رابطه ومعايناته، قبل محو الملفات التي قد يقرؤها.
        PlaybackCenter.shared.stopAll()
        uploads.cancelLightCopies()
        let services = UploadServices.shared
        let engine = uploads.engine
        let auth = self.auth
        let push = self.push
        let steps: [WipeStep] = [
            // قرار المنسّق: إبطال كل الجلسات على الخادم بأفضل جهد (≤3 ث) قبل المحو؛ لا ينتظره المحو ولا يفشل بسببه.
            WipeStep(name: "revoke_remote") { await auth.revokeEverywhereBestEffort(timeout: 3) ? 1 : 0 },
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
        phase = .wiped(report)
        await applyAccountScope(signedIn: nil)
    }

    func acknowledgeAndSignIn() { phase = .signedOut }

    /// اسم التحية؛ بلا شبكة تبقى التحية بلا اسم.
    func loadProfile() async {
        guard case .signedIn = phase else { return }
        workName = (try? await AuthAPI.getMe(apiConfiguration: api))?.workName.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// بعد الدخول: الإذن ثم APNs، والتسجيل لدى الخادم حين يصل الرمز.
    private func startPush() async {
        await push.didSignIn()
        await PushBridge.shared.requestAuthorizationAndRegister()
    }

    func login(email: String, password: String, totpCode: String) async throws {
        let session = try await auth.login(email: email, password: password, totpCode: totpCode.isEmpty ? nil : totpCode)
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
        // سجلات الرفع باقية وتكمل في الخلفية (قرار المنسّق، ADR 0091)، لكن لا يُعرض منها شيء حتى يدخل صاحبها، ولا تطلب النواة
        // باسم أحد؛ والإيصال المعروض يعود إلى انتظار صاحبه.
        await applyAccountScope(signedIn: nil)
        // لا يبقى لمراسل خرج مكانٌ ولا وسوم ولا مصغّرات، ولا إرسالاته بعناوينها وجواب حساسيتها (`send-batches.json`)، لمن يدخل
        // بعده على الهاتف نفسه؛ كما في الإبطال والمسح.
        memory.clear()
        uploads.forgetBatches()
        ThumbnailCache.shared.clear()
        workName = nil
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

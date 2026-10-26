import DeviceSecurity
import LocalAuthentication
import SwiftUI

/// Face ID أو Touch ID، ورمز الجهاز بديلًا.
struct LocalAuthenticator: DeviceOwnerAuthenticator {
    var isAvailable: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }

    func authenticate(reason: String) async -> Bool {
        (try? await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

/// قفل التطبيق كما تراه الواجهة. الخيار اختياري وافتراضيه مطفأ، وتفعيله يطلب مصادقة ناجحة.
@MainActor
final class AppLockModel: ObservableObject {
    static let enabledKey = "appLockEnabled"

    @Published private(set) var state: AppLockState
    @Published var unavailable = false
    private let authenticator: any DeviceOwnerAuthenticator
    private var prompting = false
    /// المطالبة عند العودة من الخلفية فقط؛ إلغاء المطالبة نفسه يمر بـ inactive ثم active ولا يعيدها.
    private var promptOnActive = false

    init(authenticator: any DeviceOwnerAuthenticator = LocalAuthenticator()) {
        self.authenticator = authenticator
        state = AppLockState(enabled: UserDefaults.standard.bool(forKey: Self.enabledKey))
        promptOnActive = state.isLocked
    }

    func setEnabled(_ on: Bool) async {
        guard on else {
            state.disable()
            UserDefaults.standard.set(false, forKey: Self.enabledKey)
            return
        }
        guard authenticator.isAvailable else { unavailable = true; return }
        let ok = await authenticator.authenticate(reason: String(localized: "lock.reason.enable"))
        if state.enable(authenticated: ok) { UserDefaults.standard.set(true, forKey: Self.enabledKey) }
    }

    func sceneChanged(to phase: ScenePhase, signedIn: Bool) {
        switch phase {
        case .background:
            state.didEnterBackground()
            promptOnActive = state.isLocked
        case .active where promptOnActive && signedIn:
            promptOnActive = false
            Task { await unlock() }
        default:
            break
        }
    }

    func unlock() async {
        guard state.isLocked, !prompting else { return }
        prompting = true
        defer { prompting = false }
        state.authenticationFinished(success: await authenticator.authenticate(reason: String(localized: "lock.reason.unlock")))
    }

    /// بعد المسح الطارئ: الإعداد يعود إلى افتراضيه.
    func reset() {
        state.disable()
        UserDefaults.standard.removeObject(forKey: Self.enabledKey)
    }
}

/// شاشة القفل: تغطي كل شيء، وتبقي المسح الطارئ متاحًا دون فتح التطبيق.
struct AppLockView: View {
    @EnvironmentObject private var lock: AppLockModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.fill").font(.system(size: 48)).foregroundStyle(.secondary)
            Text("lock.title").font(.title2.weight(.semibold))
            Button("lock.unlock") { Task { await lock.unlock() } }.buttonStyle(.borderedProminent)
            EmergencyWipeButton()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        // عند الإطلاق مقفلًا: المطالبة مرة حين يظهر القفل والمشهد نشط؛ العودة من الخلفية تتولاها `sceneChanged`.
        .onAppear { if scenePhase == .active { Task { await lock.unlock() } } }
    }
}

import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var lock: AppLockModel
    @Environment(\.scenePhase) private var scenePhase
    /// القفل وغطاء مبدّل التطبيقات في نافذة فوق هذه النافذة (ADR 0113): لا يُرسم فوقهما ما يُعرض هنا بـ fullScreenCover أو sheet.
    @StateObject private var shield = PrivacyShield()

    private var showsLock: Bool {
        if case .signedIn = app.phase { return lock.state.isLocked }
        return false
    }

    var body: some View {
        ZStack {
            switch app.phase {
            case .loading:
                SplashView()
            case .signedOut:
                LoginView()
            case .signedIn:
                HomeView()
            case .revoked(_, let report):
                SessionRevokedView(report: report)
            case .wiped(let report):
                WipedView(report: report)
            }
            if showsLock, !shield.isInstalled {
                AppLockView()
            }
        }
        .tint(Color.vl.actionPrimary)
        .background {
            WindowReader { window in
                shield.install(above: window) {
                    PrivacyShieldView(shield: shield).environmentObject(app).environmentObject(lock)
                }
            }
        }
        .onChange(of: showsLock, initial: true) { _, locked in shield.setLocked(locked) }
        .onChange(of: scenePhase, initial: true) { _, phase in shield.scenePhase = phase }
        .onChange(of: scenePhase) { _, phase in
            if case .signedIn = app.phase { lock.sceneChanged(to: phase, signedIn: true) } else { lock.sceneChanged(to: phase, signedIn: false) }
            // الهاتف فُتح: ما تعذّرت قراءته في إطلاق خلفي والهاتف مقفل (الإرسالات والمسودات) يُقرأ الآن.
            if phase == .active {
                app.uploads.reloadFromDisk()
                Task { await app.becameActive() }
            }
        }
    }
}

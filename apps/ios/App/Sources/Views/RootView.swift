import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var lock: AppLockModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            switch app.phase {
            case .loading:
                SplashView()
            case .signedOut:
                LoginView()
            case .signedIn:
                HomeView()
            case .revoked:
                SessionRevokedView()
            case .wiped(let report):
                WipedView(report: report)
            }
            if case .signedIn = app.phase, lock.state.isLocked {
                AppLockView()
            }
            // إخفاء المحتوى في مبدّل التطبيقات: غطاء حين لا يكون المشهد نشطًا.
            if scenePhase != .active {
                Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            }
        }
        .tint(Color.vl.actionPrimary)
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
